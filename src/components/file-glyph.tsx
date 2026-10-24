import File from "@boxicons/react/File";
import Image from "@boxicons/react/Image";
import Music from "@boxicons/react/Music";
import FileZip from "@boxicons/react/FileZip";
import FileCode from "@boxicons/react/FileCode";

export function filePresentation(name: string, mime?: string | null) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime?.startsWith("image/") || /^(png|jpe?g|gif|webp|svg|avif)$/.test(ext))
    return {
      Icon: Image,
      kind: "image",
      label: "Image",
      tag: ext.toUpperCase(),
    };
  if (mime?.startsWith("audio/") || /^(mp3|wav|flac|ogg)$/.test(ext))
    return {
      Icon: Music,
      kind: "audio",
      label: "Audio",
      tag: ext.toUpperCase(),
    };
  if (/^(zip|gz|tar|7z|rar)$/.test(ext))
    return {
      Icon: FileZip,
      kind: "archive",
      label: "Archive",
      tag: ext.toUpperCase(),
    };
  if (/^(js|ts|tsx|html|css|json|py|sql)$/.test(ext))
    return {
      Icon: FileCode,
      kind: "code",
      label: "Code",
      tag: ext.toUpperCase(),
    };
  const label =
    ext === "pdf"
      ? "PDF document"
      : /^(xls|xlsx|csv)$/.test(ext)
        ? "Spreadsheet"
        : /^(doc|docx|txt|md)$/.test(ext)
          ? "Document"
          : /^(mp4|mov|webm)$/.test(ext)
            ? "Video"
            : "File";
  return {
    Icon: File,
    kind: label === "Spreadsheet" ? "sheet" : "document",
    label,
    tag: ext.length <= 5 ? ext.toUpperCase() : "FILE",
  };
}
export function FileGlyph({
  name,
  mime,
}: {
  name: string;
  mime?: string | null;
}) {
  const { Icon, kind, tag } = filePresentation(name, mime);
  return (
    <span className={`file-glyph file-glyph--${kind}`} aria-hidden="true">
      <Icon width={36} height={36} />
      {tag && <small>{tag}</small>}
    </span>
  );
}
