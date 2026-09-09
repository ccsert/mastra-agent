import { Alert, Button, Drawer, Form, type FormInstance } from "antd";
import type { ReactNode } from "react";
import { useOperation } from "./useOperation";
export type EditorCallbacks = { onClose(): void; onSaved(): void };
/** Owns only form submission lifetime and drawer chrome. Fields, values and persistence belong to the feature. */
export function EditorForm<T extends object>({
  title,
  form,
  children,
  notice,
  ready = true,
  submitLabel = "保存",
  onSubmit,
  onClose,
  onSaved,
}: EditorCallbacks & {
  title: string;
  form: FormInstance<T>;
  children: ReactNode;
  notice?: ReactNode;
  ready?: boolean;
  submitLabel?: string;
  onSubmit(values: T, signal: AbortSignal): Promise<void>;
}) {
  const { busy, error, run } = useOperation();
  return (
    <Drawer
      title={title}
      open
      onClose={onClose}
      size={560}
      destroyOnHidden
      footer={
        <div className="dialog-footer">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} disabled={!ready} onClick={() => form.submit()}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      {error && <Alert type="error" title={error} showIcon className="form-alert" />}
      {notice}
      <Form
        form={form}
        layout="vertical"
        requiredMark="optional"
        disabled={!ready || busy}
        onFinish={(values) => {
          if (ready)
            void run(async (signal) => {
              await onSubmit(values, signal);
              signal.throwIfAborted();
              onSaved();
              onClose();
            });
        }}
      >
        {children}
      </Form>
    </Drawer>
  );
}
