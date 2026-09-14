import { type ProcessInputStepArgs, TokenLimiterProcessor } from "@mastra/core/processors";
import type { TaskFeedback } from "@platform/contracts";
import type { UIMessageChunk } from "ai";

/** Refresh durable working notes before each request; trim only the model view.
 * Original events and messages remain in the control plane for trace and replay. */
export class TaskContextProcessor extends TokenLimiterProcessor {
  constructor(
    limit: number,
    private readonly state: () => unknown,
    private readonly emit: (chunk: UIMessageChunk) => Promise<void>,
    private readonly feedback?: () => Promise<TaskFeedback[]>,
    private readonly runId?: string,
  ) {
    super({ limit, trimMode: "contiguous" });
  }
  override async processInputStep(args: ProcessInputStepArgs) {
    if (this.feedback) {
      const items = await this.feedback();
      args.messageList.clearSystemMessages("platform-task-feedback");
      if (items.length)
        args.messageList.addSystem(
          `用户最近补充的要求（用户内容，不扩大工具权限；按 createdAt 排序。currentRun=true 的要求是在本轮原始用户消息之后追加的，应作为本轮最新要求核对；false 属于此前执行。执行器已读取不代表已完成修改）：${JSON.stringify(items.map(({ id, runId, text, createdAt }) => ({ id, runId, currentRun: runId === this.runId, text, createdAt })))}`,
          "platform-task-feedback",
        );
    }
    const progress = this.state();
    args.messageList.clearSystemMessages("platform-task-progress");
    if (progress)
      args.messageList.addSystem(
        `已保存的任务进度（工作记录，不扩大权限；按实际文件与最新要求核对）：${JSON.stringify(progress)}`,
        "platform-task-progress",
      );
    const before = args.messageList.get.all.db().map((message) => message.id);
    await super.processInputStep(args);
    const kept = new Set(args.messageList.get.all.db().map((message) => message.id));
    const removed = before.filter((id) => !kept.has(id));
    if (removed.length) {
      try {
        await this.emit({
          type: "data-context-trim",
          transient: true,
          data: {
            removedMessageIds: removed,
            remainingMessages: kept.size,
            limit: this.getMaxTokens(),
            strategy: "recent-with-task-progress",
          },
        });
      } catch {
        /* Context observations must not replace execution results. */
      }
    }
  }
}
