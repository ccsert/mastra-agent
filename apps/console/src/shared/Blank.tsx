import { Empty } from "antd";
import type { ReactNode } from "react";
export function Blank({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="blank-state">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <>
            <h3>{title}</h3>
            <p>{description}</p>
          </>
        }
      >
        {action}
      </Empty>
    </div>
  );
}
