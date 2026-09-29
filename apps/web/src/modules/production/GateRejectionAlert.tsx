import { Alert, Typography } from "antd";
import { StudioHttpError } from "../../api/studio-client";

const { Text } = Typography;

interface GateRejectionBody {
  message?: string;
  missing?: string[];
  failed?: { check_id: string; evidence: { problems?: { code: string; message: string }[] } }[];
}

/** Renders a gate's 422 rejection (`{ message, code: "rejected", missing, failed }`), or any other error. */
export function GateRejectionAlert({ error }: { error: unknown }) {
  if (!(error instanceof StudioHttpError) || error.status !== 422) {
    return (
      <Alert
        type="error"
        message="Không thể duyệt"
        description={error instanceof Error ? error.message : String(error)}
        showIcon
      />
    );
  }
  const body = error.body as GateRejectionBody | null;
  return (
    <Alert
      type="error"
      showIcon
      message={body?.message ?? "Bị từ chối"}
      description={
        <div>
          {!!body?.missing?.length && <div>Thiếu: {body.missing.join(", ")}</div>}
          {body?.failed?.map((f) => (
            <div key={f.check_id} style={{ marginTop: 4 }}>
              <Text strong>{f.check_id}</Text>
              {f.evidence?.problems?.map((p, i) => (
                <div key={i} style={{ paddingLeft: 12 }}>
                  <Text type="secondary">
                    {p.code}: {p.message}
                  </Text>
                </div>
              ))}
            </div>
          ))}
        </div>
      }
    />
  );
}
