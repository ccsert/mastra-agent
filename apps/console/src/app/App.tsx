import { SessionBoundary } from "./auth/SessionBoundary";
import { Workspace } from "./Workspace";

export function App() {
  return (
    <SessionBoundary>
      {(session) => <Workspace key={`${session.user.tenantId}:${session.user.id}`} {...session} />}
    </SessionBoundary>
  );
}
