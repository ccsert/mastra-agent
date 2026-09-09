import type { KnowledgeBase, Model } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Drawer, Empty, Form, Input, InputNumber, Select } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { useProjectRefresh } from "../../shared/data/ProjectData";
import { useLifetime } from "../../shared/useLifetime";
export function KnowledgeCreate({
  projectId,
  models,
  onCreated,
  onClose,
  onConfigureModels,
}: {
  projectId: string;
  models: Model[];
  onCreated(kb: KnowledgeBase): void;
  onClose(): void;
  onConfigureModels(): void;
}) {
  const lifetime = useLifetime(),
    refresh = useProjectRefresh();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const embeddings = models.filter((model) => model.kind === "embedding"),
    rerankers = models.filter((model) => model.kind === "rerank");
  async function create(values: {
    name: string;
    description?: string;
    embeddingModelId: string;
    rerankModelId?: string;
    chunkSize: number;
    chunkOverlap: number;
  }) {
    const signal = lifetime();
    setSaving(true);
    setError("");
    try {
      const item = await unwrap(
        api.createKnowledgeBase({
          signal,
          path: { projectId },
          body: { ...values, rerankModelId: values.rerankModelId ?? null },
        }),
        signal,
      );
      void refresh("knowledgeBases");
      onCreated(item);
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  }
  return (
    <Drawer
      title="创建知识库"
      open
      onClose={() => onClose()}
      size={520}
      destroyOnHidden
      footer={
        <div className="dialog-footer">
          <Button onClick={() => onClose()}>取消</Button>
          <Button
            type="primary"
            disabled={!embeddings.length}
            loading={saving}
            onClick={() => form.submit()}
          >
            创建
          </Button>
        </div>
      }
    >
      {error && <Alert type="error" title={error} className="form-alert" />}
      {!embeddings.length ? (
        <Empty description="先接入一个向量模型服务">
          <Button
            onClick={() => {
              onClose();
              onConfigureModels();
            }}
          >
            接入向量模型
          </Button>
        </Empty>
      ) : (
        <Form
          form={form}
          layout="vertical"
          onFinish={create}
          initialValues={{ chunkSize: 800, chunkOverlap: 80 }}
        >
          <Form.Item
            name="name"
            label="知识库名称"
            rules={[{ required: true, whitespace: true, message: "请输入名称" }]}
          >
            <Input maxLength={80} placeholder="例如：产品与业务资料" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea maxLength={500} rows={2} />
          </Form.Item>
          <Form.Item
            name="embeddingModelId"
            label="向量模型"
            rules={[{ required: true, message: "请选择向量模型" }]}
          >
            <Select
              options={embeddings.map((m) => ({
                value: m.id,
                label: `${m.name}${m.dimensions ? ` · ${m.dimensions} 维` : ""}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="rerankModelId" label="重排模型（可选）">
            <Select
              allowClear
              placeholder="使用向量相似度排序"
              options={rerankers.map((m) => ({ value: m.id, label: m.name }))}
            />
          </Form.Item>
          <div className="knowledge-form-row">
            <Form.Item name="chunkSize" label="分段字符数" rules={[{ required: true }]}>
              <InputNumber min={200} max={2000} precision={0} />
            </Form.Item>
            <Form.Item name="chunkOverlap" label="重叠字符数" rules={[{ required: true }]}>
              <InputNumber min={0} max={100} precision={0} />
            </Form.Item>
          </div>
          <Alert
            type="info"
            title="知识库固定模型与分段配置。需要更换模型或维度时，请创建新知识库并重新入库。"
          />
        </Form>
      )}
    </Drawer>
  );
}
