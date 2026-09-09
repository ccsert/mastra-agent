import { type InfiniteData, infiniteQueryOptions } from "@tanstack/react-query";
import { Button, Space, Typography } from "antd";
import type { Page } from "../api";

export function pageOptions<T>(
  queryKey: readonly string[],
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
) {
  return infiniteQueryOptions({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => load(pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export function pageItems<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}
/** Keep mutation feedback immediate while preserving the current continuation cursor. */
export function prependPage<T extends { id: string }>(
  data: InfiniteData<Page<T>> | undefined,
  item: T,
): InfiniteData<Page<T>> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      items: [...(index ? [] : [item]), ...page.items.filter((old) => old.id !== item.id)],
    })),
  };
}
export function PageMore({
  query,
  count,
  label = "记录",
}: {
  count: number;
  label?: string;
  query: {
    hasNextPage: boolean;
    isFetching: boolean;
    isFetchNextPageError: boolean;
    fetchNextPage(options: { cancelRefetch: boolean }): Promise<unknown>;
  };
}) {
  return (
    <Space wrap style={{ marginBlock: 16 }}>
      <Typography.Text type="secondary">
        已加载 {count} 条{label}
        {query.hasNextPage ? "" : " · 已全部加载"}
      </Typography.Text>
      {query.hasNextPage && (
        <Button
          loading={query.isFetching}
          onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
        >
          {query.isFetchNextPageError ? "重试加载更多" : "加载更多"}
          {label}
        </Button>
      )}
    </Space>
  );
}
