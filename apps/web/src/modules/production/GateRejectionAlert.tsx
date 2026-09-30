import { Alert, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/studio-client";

const { Text } = Typography;

interface GateRejectionBody {
  message?: string;
  missing?: string[];
  failed?: { check_id: string; evidence: { problems?: { code: string; message: string }[] } }[];
}

/** Renders a gate's 422 rejection (`{ message, code: "rejected", missing, failed }`), or any other error. */
export function GateRejectionAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!(error instanceof StudioHttpError) || error.status !== 422) {
    return (
      <Alert
        type="error"
        message={t("gateRejection.cannotApprove")}
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
      message={body?.message ?? t("gateRejection.rejected")}
      description={
        <div>
          {!!body?.missing?.length && <div>{t("gateRejection.missing", { items: body.missing.join(", ") })}</div>}
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
