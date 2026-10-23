import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { DesktopFile, DesktopFact } from "../domain/desktopApplication.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { observeIl2cppMetadataHeaderPrefix } from "../domain/il2cpp/il2cppMetadataHeaderPrefix.js";
import {
  parsePeRecord,
  peRvaToFileOffset,
  type ExecutableMetadata,
} from "../domain/binaryTarget.js";
import { readManagedMetadataLayout } from "../dotnet/ManagedMetadataLayout.js";
import { readAssemblyReferenceName } from "../dotnet/ManagedMetadataInventoryRows.js";
import { ManagedReaderFailure } from "../dotnet/ManagedReaderFailure.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import { hasMachoMagic } from "./apple/MachoLoadCommandReader.js";

export interface DesktopReadBudget {
  bytes: number;
  readonly maximum: number;
  retainedBytes: number;
  readonly maximumRetainedBytes: number;
}

/** A resource refusal is separate from malformed format declarations. */
class DesktopProbeLimit extends ArtifactReaderFailure {
  constructor() {
    super("limit", "Directory probe byte budget exhausted", {
      boundary: "capacity",
    });
  }
}

/** Inspect selected ranges on an already admitted descriptor; never hash payloads. */
export const inspectDesktopFile = async (
  file: FileHandle,
  row: DesktopFile,
  budget: DesktopReadBudget,
  signal?: AbortSignal,
  unityManagedDirectory: string | null = null,
): Promise<void> => {
  const size = row.bytes;
  if (size === null)
    throw new ArtifactReaderFailure(
      "limit",
      "File extent exceeds exact host offsets",
      { boundary: "file-size" },
    );
  const read = async (offset: number, bytes: number): Promise<Buffer> => {
    abortIfNeeded(signal);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      offset > size ||
      bytes > size - offset
    )
      throw new ArtifactReaderFailure(
        "format",
        "Declared byte range lies outside the file",
      );
    if (bytes > budget.maximum - budget.bytes) throw new DesktopProbeLimit();
    const result = Buffer.alloc(bytes);
    let consumed = 0;
    while (consumed < bytes) {
      abortIfNeeded(signal);
      const part = await file.read(
        result,
        consumed,
        bytes - consumed,
        offset + consumed,
      );
      budget.bytes += part.bytesRead;
      if (part.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "File ended before its observed extent",
        );
      consumed += part.bytesRead;
    }
    abortIfNeeded(signal);
    row.ranges.push({
      offset,
      bytes,
      sha256: createHash("sha256").update(result).digest("hex"),
    });
    return result;
  };
  const fact = (observation: DesktopFact) => {
    const remaining = budget.maximumRetainedBytes - budget.retainedBytes;
    const reservation =
      512 + jsonValueByteLength(observation.value, (remaining - 512) / 12) * 12;
    if (reservation > budget.maximumRetainedBytes - budget.retainedBytes)
      throw new ArtifactReaderFailure(
        "limit",
        "Directory facts reached the retained metadata budget",
        { boundary: "memory" },
      );
    budget.retainedBytes += reservation;
    row.facts.push(observation);
  };
  const prefix = await read(0, Math.min(size, 64));
  const metadataPrefix = observeIl2cppMetadataHeaderPrefix(prefix);
  if (metadataPrefix.kind === "il2cpp")
    fact({
      kind: "il2cpp-metadata-header",
      offset: 0,
      value: {
        magic: "0xfab11baf",
        raw_version: metadataPrefix.rawVersion,
      },
    });
  if (prefix.length >= 20 && prefix.toString("latin1", 0, 4) === "GDPC")
    fact({
      kind: "godot-pck-header",
      offset: 0,
      value: {
        pack_version: prefix.readUInt32LE(4),
        engine_version: [
          prefix.readUInt32LE(8),
          prefix.readUInt32LE(12),
          prefix.readUInt32LE(16),
        ],
        placement: "standalone",
      },
    });
  if (
    prefix.length >= 16 &&
    prefix.toString("latin1", 0, 4) === "FORM" &&
    prefix.toString("latin1", 8, 12) === "GEN8"
  ) {
    const containerBytes = prefix.readUInt32LE(4);
    const chunkBytes = prefix.readUInt32LE(12);
    if (
      containerBytes >= 8 &&
      containerBytes <= size - 8 &&
      chunkBytes <= containerBytes - 8
    )
      fact({
        kind: "gamemaker-form-header",
        offset: 0,
        value: {
          container: "FORM",
          first_chunk: "GEN8",
        },
      });
  }
  if (
    prefix.length >= 16 &&
    prefix.toString("latin1", 0, 16) === "-==--==--==--==-"
  )
    fact({
      kind: "unreal-container-convention",
      offset: 0,
      value: { format: "IoStore TOC" },
    });
  const native =
    prefix.length >= 4 &&
    (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      hasMachoMagic(prefix));
  if (native)
    fact({
      kind: "native-image-header",
      offset: 0,
      value: {
        format: prefix[0] === 0x7f ? "elf" : "mach-o",
        signature: prefix.subarray(0, 4).toString("hex"),
      },
    });
  const observe = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        (cause.reason !== "format" && cause.reason !== "limit")
      )
        throw cause;
      if (!row.issues.includes(cause.message)) row.issues.push(cause.message);
    }
  };
  let peRole: PeExecutableRole | null = null;
  if (prefix.length === 64 && prefix.readUInt16LE(0) === 0x5a4d)
    await observe(async () => {
      peRole = await inspectPeFile(
        prefix,
        row,
        read,
        fact,
        unityManagedDirectory,
        signal,
      );
    });
  if (
    (native || (prefix.length >= 2 && prefix.readUInt16LE(0) === 0x5a4d)) &&
    size >= 12
  )
    await observe(() => inspectPckTrailer(size, read, fact));
  const executable = isThinMachoExecutable(prefix);
  let archiveEnd = size;
  let placement: "file-end" | "before-code-signature" = "file-end";
  if (executable !== null)
    await observe(async () => {
      const signature = await inspectMachoExecutableSections(
        prefix,
        executable,
        read,
        fact,
      );
      if (signature !== null) {
        archiveEnd = signature;
        placement = "before-code-signature";
      }
    });
  // PyInstaller always produces an executable; libraries and FAT containers
  // are not probed, so directories of DLLs or dylibs pay no extra reads.
  if (
    executable !== null ||
    peRole === "application" ||
    isElfEntryImage(prefix)
  )
    await observe(() =>
      inspectPyInstallerCookie(archiveEnd, placement, read, fact),
    );
};

type PeExecutableRole = Extract<
  ExecutableMetadata,
  { readonly format: "pe" }
>["executableRole"];

/** Little-endian ELF executable or PIE image with a declared entry point. */
const isElfEntryImage = (prefix: Buffer): boolean => {
  if (
    prefix.length < 32 ||
    !prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    prefix[5] !== 1
  )
    return false;
  const type = prefix.readUInt16LE(16);
  if (type !== 2 && type !== 3) return false;
  return prefix[4] === 2
    ? prefix.readBigUInt64LE(24) !== 0n
    : prefix.readUInt32LE(24) !== 0;
};

const MACHO_MAGIC_32 = 0xfeedface;
const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_EXECUTE = 2;
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
/** Executable load-command tables are a few KiB; larger tables are not scanned. */
const DESKTOP_LOAD_COMMAND_BYTES = 256 * 1024;
const GO_BUILD_INFO_SECTION = "__go_buildinfo";
const PYINSTALLER_COOKIE = Buffer.from([
  0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e,
]);
/** PyInstaller 2.1+ CArchive cookie: magic, four big-endian u32s, library name. */
const PYINSTALLER_COOKIE_BYTES = 88;
/** A Mach-O code signature starts 16-byte aligned after the appended archive. */
const CODE_SIGNATURE_ALIGNMENT_PADDING = 15;

const fixedName = (bytes: Buffer, offset: number, length: number): string => {
  const field = bytes.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.toString("latin1", 0, end < 0 ? field.length : end);
};

/** Little-endian thin Mach-O main executables only; FAT and dylibs are skipped. */
const isThinMachoExecutable = (
  prefix: Buffer,
): { readonly wide: boolean } | null => {
  if (prefix.length < 32) return null;
  const magic = prefix.readUInt32LE(0);
  if (magic !== MACHO_MAGIC_32 && magic !== MACHO_MAGIC_64) return null;
  if (prefix.readUInt32LE(12) !== MACHO_EXECUTE) return null;
  return { wide: magic === MACHO_MAGIC_64 };
};

/**
 * Record a declared `__go_buildinfo` section and return the code signature's
 * file offset, if any. Section names are format declarations; whether the
 * section holds valid Go build information is left to `inspect_go_binary`.
 */
const inspectMachoExecutableSections = async (
  prefix: Buffer,
  image: { readonly wide: boolean },
  read: DesktopByteRead,
  fact: RecordDesktopFact,
): Promise<number | null> => {
  const headerBytes = image.wide ? 32 : 28;
  const count = prefix.readUInt32LE(16);
  const commandBytes = prefix.readUInt32LE(20);
  if (commandBytes > DESKTOP_LOAD_COMMAND_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      "Mach-O load commands exceed the desktop section-scan bound",
      { boundary: "capacity" },
    );
  const commands = await read(headerBytes, commandBytes);
  let signature: number | null = null;
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > commands.length)
      throw new ArtifactReaderFailure(
        "format",
        "Mach-O load command table ends before its declared count",
      );
    const command = commands.readUInt32LE(cursor);
    const commandSize = commands.readUInt32LE(cursor + 4);
    if (commandSize < 8 || commandSize > commands.length - cursor)
      throw new ArtifactReaderFailure(
        "format",
        "Mach-O load command size lies outside its table",
      );
    if (command === LC_SEGMENT || command === LC_SEGMENT_64) {
      const wide = command === LC_SEGMENT_64;
      const segmentBytes = wide ? 72 : 56;
      const sectionBytes = wide ? 80 : 68;
      if (commandSize < segmentBytes)
        throw new ArtifactReaderFailure(
          "format",
          "Mach-O segment command is shorter than its header",
        );
      const sections = commands.readUInt32LE(cursor + (wide ? 64 : 48));
      if (sections > (commandSize - segmentBytes) / sectionBytes)
        throw new ArtifactReaderFailure(
          "format",
          "Mach-O segment declares more sections than its command holds",
        );
      for (let item = 0; item < sections; item++) {
        const base = cursor + segmentBytes + item * sectionBytes;
        const section = fixedName(commands, base, 16);
        if (section !== GO_BUILD_INFO_SECTION) continue;
        fact({
          kind: "go-build-info-section",
          offset: headerBytes + base,
          value: { segment: fixedName(commands, base + 16, 16), section },
        });
      }
    } else if (command === LC_CODE_SIGNATURE && commandSize >= 16)
      signature = commands.readUInt32LE(cursor + 8);
    cursor += commandSize;
  }
  return signature;
};

/**
 * PyInstaller appends a CArchive whose 88-byte cookie ends the archive. On a
 * signed Mach-O the archive ends before the code signature, after at most
 * 15 bytes of alignment padding; otherwise it ends the file.
 */
const inspectPyInstallerCookie = async (
  archiveEnd: number,
  placement: "file-end" | "before-code-signature",
  read: DesktopByteRead,
  fact: RecordDesktopFact,
): Promise<void> => {
  const padding =
    placement === "before-code-signature"
      ? CODE_SIGNATURE_ALIGNMENT_PADDING
      : 0;
  const window = Math.min(archiveEnd, PYINSTALLER_COOKIE_BYTES + padding);
  if (window < PYINSTALLER_COOKIE_BYTES) return;
  const tail = await read(archiveEnd - window, window);
  const at = tail.lastIndexOf(PYINSTALLER_COOKIE);
  if (at < 0 || at + PYINSTALLER_COOKIE_BYTES > tail.length) return;
  const cookie = tail.subarray(at, at + PYINSTALLER_COOKIE_BYTES);
  const cookieOffset = archiveEnd - window + at;
  const archiveBytes = cookie.readUInt32BE(8);
  const tocOffset = cookie.readUInt32BE(12);
  const tocBytes = cookie.readUInt32BE(16);
  const cookieEnd = cookieOffset + PYINSTALLER_COOKIE_BYTES;
  if (archiveBytes > cookieEnd || tocBytes > archiveBytes - tocOffset)
    throw new ArtifactReaderFailure(
      "format",
      "PyInstaller cookie declares an archive or table of contents outside the file",
    );
  fact({
    kind: "pyinstaller-archive-cookie",
    offset: cookieOffset,
    value: {
      archive_offset: cookieEnd - archiveBytes,
      archive_bytes: archiveBytes,
      toc_bytes: tocBytes,
      python_version: cookie.readUInt32BE(20),
      python_library: fixedName(cookie, 24, 64),
      placement,
    },
  });
};

type DesktopByteRead = (offset: number, bytes: number) => Promise<Buffer>;
type RecordDesktopFact = (observation: DesktopFact) => void;

const inspectPeFile = async (
  prefix: Buffer,
  row: DesktopFile,
  read: DesktopByteRead,
  fact: RecordDesktopFact,
  unityManagedDirectory: string | null,
  signal?: AbortSignal,
): Promise<PeExecutableRole | null> => {
  const peOffset = prefix.readUInt32LE(0x3c);
  const coff = await read(peOffset, 24);
  if (coff.toString("latin1", 0, 4) !== "PE\0\0") return null;
  const optionalSize = coff.readUInt16LE(20);
  if (optionalSize > 4096)
    throw new ArtifactReaderFailure(
      "format",
      "PE optional header exceeds the supported format bound",
    );
  const optional = await read(peOffset + 24, optionalSize);
  const parsed = parsePeRecord(Buffer.concat([coff, optional]), undefined);
  if (!parsed.ok) {
    row.issues.push(parsed.error);
    return null;
  }
  if (parsed.value.format !== "pe") return null;
  fact({
    kind: "native-image-header",
    offset: peOffset,
    value: { format: "pe", machine: coff.readUInt16LE(4) },
  });
  const role = parsed.value.executableRole;
  if (!parsed.value.managed) return role;
  const directories = optional.readUInt16LE(0) === 0x20b ? 112 : 96;
  const cliRva = optional.readUInt32LE(directories + 14 * 8);
  const cliSize = optional.readUInt32LE(directories + 14 * 8 + 4);
  fact({
    kind: "pe-cli-directory",
    offset: peOffset + 24 + directories + 14 * 8,
    value: { rva: cliRva, bytes: cliSize },
  });
  if (unityManagedDirectory === null) return role;
  const sectionCount = coff.readUInt16LE(6);
  const sections = await read(peOffset + 24 + optionalSize, sectionCount * 40);
  const mapped = (rva: number, bytes: number) =>
    peRvaToFileOffset(
      rva,
      sections,
      sectionCount,
      optional.readUInt32LE(60),
      bytes,
    );
  const cliOffset = mapped(cliRva, 16);
  if (cliOffset === undefined || cliSize < 72)
    throw new ArtifactReaderFailure(
      "format",
      "CLI metadata directory cannot be mapped",
    );
  const cli = await read(cliOffset, 16);
  if (cli.readUInt32LE(0) < 72)
    throw new ArtifactReaderFailure(
      "format",
      "CLI header declares a truncated runtime header",
    );
  const metadataBytes = cli.readUInt32LE(12);
  const metadataOffset = mapped(cli.readUInt32LE(8), metadataBytes);
  if (metadataOffset === undefined)
    throw new ArtifactReaderFailure(
      "format",
      "CLI metadata range cannot be mapped",
    );
  const bytes = await read(metadataOffset, metadataBytes);
  try {
    const layout = readManagedMetadataLayout(bytes, 0, bytes.length);
    const refs = layout.table(35);
    for (let index = 1; index <= (refs?.rowCount ?? 0); index++) {
      // Yield between bounded batches so metadata names cannot monopolize MCP.
      if ((index - 1) % 256 === 0) {
        await setImmediate();
        abortIfNeeded(signal);
      }
      const reference = readAssemblyReferenceName(
        bytes,
        layout,
        index,
        layout.strings.size,
      );
      if (
        reference.name !== "UnityEngine" &&
        !reference.name.startsWith("UnityEngine.")
      )
        continue;
      fact({
        kind: "unity-assembly-reference",
        offset: metadataOffset + reference.row_offset,
        value: {
          name: reference.name,
          token: reference.token,
          managed_directory: unityManagedDirectory,
        },
      });
      return role;
    }
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    throw new ArtifactReaderFailure(
      cause.issue.code === "resource-limit" ? "limit" : "format",
      cause.message,
      {
        cause,
        ...(cause.issue.code === "resource-limit"
          ? { boundary: "memory" as const }
          : {}),
      },
    );
  }
  return role;
};

const inspectPckTrailer = async (
  size: number,
  read: DesktopByteRead,
  fact: RecordDesktopFact,
): Promise<void> => {
  const trailer = await read(size - 12, 12);
  if (trailer.toString("latin1", 8, 12) === "GDPC") {
    const packSize = trailer.readBigUInt64LE(0);
    if (packSize < 20n || packSize > BigInt(size - 12))
      throw new ArtifactReaderFailure(
        "format",
        "Embedded PCK trailer declares an invalid pack extent",
      );
    const offset = size - 12 - Number(packSize);
    const header = await read(offset, 20);
    if (header.toString("latin1", 0, 4) !== "GDPC")
      throw new ArtifactReaderFailure(
        "format",
        "Embedded PCK trailer does not locate a pack header",
      );
    fact({
      kind: "godot-pck-header",
      offset,
      value: {
        pack_version: header.readUInt32LE(4),
        engine_version: [
          header.readUInt32LE(8),
          header.readUInt32LE(12),
          header.readUInt32LE(16),
        ],
        placement: "embedded-trailer",
      },
    });
  }
};
