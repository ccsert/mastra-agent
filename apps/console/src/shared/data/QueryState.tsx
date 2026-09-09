import { Alert, Button, Spin } from "antd";
import type { ReactNode } from "react";

type QueryStateValue = {
  data: unknown;
  error: Error | null;
  isFetching: boolean;
  refetch: (options: { cancelRefetch: boolean }) => Promise<unknown>;
};
/** Failed background refreshes retain the last successful data and expose an explicit retry. */
export function QueryState({
  label,
  query,
  children,
}: {
  label: string;
  query: QueryStateValue;
  children: ReactNode;
}) {
  return (
    <>
      {query.error && (
        <Alert
          className="form-alert"
          type={query.data === undefined ? "error" : "warning"}
          title={`${label}加载失败`}
          description={`${query.error.message}${query.data === undefined ? "" : "；当前显示上次成功加载的数据。"}`}
          action={
            <Button
              disabled={false}
              loading={query.isFetching}
              onClick={() => void query.refetch({ cancelRefetch: false })}
            >
              重试{label}
            </Button>
          }
        />
      )}
      {query.data !== undefined
        ? children
        : !query.error && (
            <div role="status" aria-label={`加载${label}`}>
              <Spin /> 正在加载{label}…
            </div>
          )}
    </>
  );
}
