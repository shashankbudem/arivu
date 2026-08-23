import { FileText } from "lucide-react";
import type { DiffLine, DiffPreview } from "../../shared/diff";

export function DiffBlock({ preview }: { preview: DiffPreview }) {
  return (
    <div className="diff-block">
      <div className="diff-file">
        <FileText size={13} />
        <span>{preview.title}</span>
      </div>
      <div className="diff-lines">
        {preview.lines.map((line, index) => (
          <div key={`${line.kind}-${index}-${line.oldNumber ?? ""}-${line.newNumber ?? ""}`} className={`diff-line ${line.kind}`}>
            <span className="diff-number">{line.oldNumber ?? ""}</span>
            <span className="diff-number">{line.newNumber ?? ""}</span>
            <span className="diff-prefix">{diffPrefix(line.kind)}</span>
            <code>{line.text || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function diffPrefix(kind: DiffLine["kind"]) {
  if (kind === "add") {
    return "+";
  }
  if (kind === "delete") {
    return "-";
  }
  return " ";
}
