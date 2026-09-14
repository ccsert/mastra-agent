import { Table } from "antd";
import { asRecord } from "./tool-content";

const printable = (value: unknown) =>
  value === undefined
    ? "尚未返回"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <section className="tool-result-table" aria-label="结构化工具结果">
      <p>
        {rows.length} 条记录 · {columns.length} 列
      </p>
      <Table
        size="small"
        rowKey="position"
        dataSource={rows.map((value, position) => ({ value, position }))}
        columns={columns.map((key) => ({
          title: key,
          key,
          render: (_: unknown, row: { value: Record<string, unknown> }) =>
            key in row.value ? printable(row.value[key]) : "—",
        }))}
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: "max-content", y: 360 }}
      />
    </section>
  );
}
function isRows(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        Object.values(row).every(
          (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
        ),
    )
  );
}
function StructuredResult({ value }: { value: unknown }) {
  if (isRows(value)) return <ResultTable rows={value} />;
  const entries = Object.entries(asRecord(value));
  // Common tool envelopes contain scalar summary fields and one or more row lists.
  // Only render this exact shape; arbitrary nested objects retain their original JSON.
  if (
    entries.some(([, v]) => isRows(v)) &&
    entries.every(
      ([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v) || isRows(v),
    )
  )
    return (
      <>
        <dl className="tool-result-facts">
          {entries
            .filter(([, v]) => !isRows(v))
            .map(([key, v]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{printable(v)}</dd>
              </div>
            ))}
        </dl>
        {entries
          .filter(([, v]) => isRows(v))
          .map(([key, v]) => (
            <section key={key} aria-label={key}>
              <h4>{key}</h4>
              {isRows(v) && <ResultTable rows={v} />}
            </section>
          ))}
      </>
    );
  return <pre className="tool-result-raw">{printable(value)}</pre>;
}
export function ToolResult({ toolName, result }: { toolName?: string; result: unknown }) {
  const value = asRecord(result);
  if (
    toolName === "run_skill_script" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.exitCode === "number"
  ) {
    let structured: unknown;
    try {
      structured = JSON.parse(value.stdout);
    } catch {
      /* Output is ordinary text. */
    }
    return (
      <section className="tool-script-result" aria-label="脚本执行结果">
        <div className="tool-result-heading">
          <strong>{String(value.entrypoint ?? "Skill 脚本")}</strong>
          <span data-failed={value.exitCode !== 0}>退出码 {value.exitCode}</span>
        </div>
        <p>
          {typeof value.skill === "string" && value.skill}
          {typeof value.version === "number" && ` · v${value.version}`}
        </p>
        {structured !== undefined && (
          <>
            <h4>结构化输出</h4>
            <StructuredResult value={structured} />
          </>
        )}
        <details open={structured === undefined}>
          <summary>标准输出 stdout · {value.stdout.length} 字符</summary>
          <pre className="tool-terminal">{value.stdout || "（空）"}</pre>
        </details>
        <details open={!!value.stderr}>
          <summary>标准错误 stderr · {value.stderr.length} 字符</summary>
          <pre className="tool-terminal">{value.stderr || "（空）"}</pre>
        </details>
        <details>
          <summary>完整执行记录</summary>
          <pre className="tool-result-raw">{printable(result)}</pre>
        </details>
      </section>
    );
  }
  return <StructuredResult value={result} />;
}
