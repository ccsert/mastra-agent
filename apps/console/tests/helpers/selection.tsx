import { type ReactNode, useState } from "react";
import type { ResourceSelection } from "../../src/shared/navigation";
export function Selection({
  children,
  initial,
}: {
  children(selection: ResourceSelection): ReactNode;
  initial?: string;
}) {
  const [selectedId, onSelect] = useState(initial);
  return children({ selectedId, onSelect });
}
