import { Result } from "antd";
import { Link } from "react-router";
export function RouteMissing({ project = false }: { project?: boolean }) {
  return (
    <Result
      status="404"
      title={project ? "项目不存在或无权访问" : "页面不存在"}
      subTitle="请检查链接，或返回工作空间选择可用项目。"
      extra={<Link to="/">返回工作空间</Link>}
    />
  );
}
