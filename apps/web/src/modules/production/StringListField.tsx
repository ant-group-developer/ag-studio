/**
 * StringListField — reusable Form.List of autosize textareas with add/remove buttons.
 */
import { Button, Form, Input, Space, Tooltip } from "antd";
import type { FormListFieldData } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface StringListFieldProps {
  /** Form.List `name` (relative to nearest Form.Item name) */
  name: string | (string | number)[];
  label?: string;
  maxItems?: number;
  maxChars?: number;
  readOnly?: boolean;
  addLabel?: string;
  placeholder?: string;
  rows?: number;
}

export function StringListField({
  name,
  label,
  maxItems = 10,
  maxChars,
  readOnly,
  addLabel,
  placeholder,
  rows = 8,
}: StringListFieldProps) {
  const { t } = useTranslation();

  return (
    <Form.List name={name}>
      {(fields: FormListFieldData[], { add, remove }) => (
        <div>
          {label && <div style={{ marginBottom: 4, fontSize: 14 }}>{label}</div>}
          <Space direction="vertical" style={{ width: "100%" }} size={4}>
            {fields.map((field) => (
              // A plain flex row, not <Space>: Space wraps each child in its own item div, so the
              // textarea's flex: 1 never applies and it shrinks to its minimum width.
              <div key={field.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%" }}>
                <Form.Item
                  {...field}
                  style={{ flex: 1, minWidth: 0, marginBottom: 0 }}
                  rules={
                    maxChars
                      ? [{ max: maxChars, message: `Tối đa ${maxChars} ký tự` }]
                      : undefined
                  }
                >
                  <Input.TextArea
                    autoSize={{ minRows: 1, maxRows: rows }}
                    placeholder={placeholder}
                    readOnly={readOnly}
                    maxLength={maxChars}
                  />
                </Form.Item>
                {!readOnly && (
                  <Tooltip title={t("common.delete")}>
                    <Button
                      danger
                      type="text"
                      icon={<Trash2 size={14} />}
                      onClick={() => remove(field.name)}
                      aria-label={t("common.delete")}
                    />
                  </Tooltip>
                )}
              </div>
            ))}
            {!readOnly && fields.length < maxItems && (
              <Button
                size="small"
                icon={<Plus size={12} />}
                onClick={() => add("")}
                style={{ width: "fit-content" }}
              >
                {addLabel ?? t("common.create")}
              </Button>
            )}
          </Space>
        </div>
      )}
    </Form.List>
  );
}
