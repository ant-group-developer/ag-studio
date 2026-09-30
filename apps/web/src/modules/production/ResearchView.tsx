/**
 * Research + Trend Report view for the production detail Steps page.
 * Shows StudioResearch (channels, keywords, top videos) and TrendReport.
 */
import { Alert, Badge, Card, Collapse, Descriptions, Space, Table, Tag, Typography } from "antd";
import { ExternalLink, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StudioResearch, TrendReport, ResearchVideo } from "@harness/contracts";
import type { ColumnsType } from "antd/es/table";

const { Text, Title } = Typography;

function VideoTable({ videos, production_id }: { videos: ResearchVideo[]; production_id: string }) {
  void production_id;
  const { t } = useTranslation();
  const cols: ColumnsType<ResearchVideo> = [
    {
      title: t("research.columnTitle"),
      dataIndex: "title",
      key: "title",
      ellipsis: { showTitle: false },
      render: (title: string, r: ResearchVideo) => (
        <Space size={4}>
          {r.outlier && <Tag color="gold">{t("research.outlierBadge")}</Tag>}
          <a href={`https://www.youtube.com/watch?v=${r.video_id}`} target="_blank" rel="noopener noreferrer">
            {title} <ExternalLink size={12} style={{ verticalAlign: "middle" }} />
          </a>
        </Space>
      ),
    },
    {
      title: t("research.columnViews"),
      dataIndex: "views",
      key: "views",
      width: 110,
      render: (v: number) => v.toLocaleString(),
      sorter: (a, b) => a.views - b.views,
      defaultSortOrder: "descend",
    },
    {
      title: t("research.columnViewsPerDay"),
      dataIndex: "views_per_day",
      key: "vpd",
      width: 130,
      render: (v: number) => v.toFixed(0),
    },
    {
      title: t("research.columnDuration"),
      dataIndex: "duration_s",
      key: "duration_s",
      width: 100,
      render: (s: number) => `${Math.round(s)}s`,
    },
    {
      title: t("research.columnPublished"),
      dataIndex: "published_at",
      key: "published_at",
      width: 110,
      render: (v: string) => v.slice(0, 10),
    },
  ];
  return (
    <Table
      columns={cols}
      dataSource={videos}
      rowKey="video_id"
      size="small"
      pagination={{ pageSize: 10, showSizeChanger: false }}
      scroll={{ x: 700 }}
    />
  );
}

interface Props {
  productionId: string;
  research: StudioResearch | null;
  trendReport: TrendReport | null;
  loadingResearch?: boolean;
  loadingTrend?: boolean;
}

export function ResearchView({ productionId, research, trendReport }: Props) {
  const { t } = useTranslation();

  const allVideos: ResearchVideo[] = [];
  if (research) {
    for (const ch of research.channels) allVideos.push(...ch.videos);
    for (const kw of research.keywords) allVideos.push(...kw.videos);
  }
  const dedupedVideos = allVideos.filter((v, i, a) => a.findIndex((x) => x.video_id === v.video_id) === i);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {/* Research section */}
      {research ? (
        research.skipped_reason ? (
          <Alert
            type="info"
            message={t("research.skipped", { reason: research.skipped_reason })}
            showIcon
          />
        ) : (
          <Card
            title={
              <Space>
                <TrendingUp size={16} />
                {t("research.title")}
                {research.fetched_at && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    — {t("research.fetchedAt", { time: research.fetched_at.slice(0, 16).replace("T", " ") })}
                  </Text>
                )}
              </Space>
            }
            size="small"
          >
            {research.channels.length > 0 && (
              <Collapse
                size="small"
                items={research.channels.map((ch) => ({
                  key: ch.channel_id ?? ch.input,
                  label: (
                    <Space>
                      <strong>{ch.title ?? ch.input}</strong>
                      {ch.subscribers != null && (
                        <Text type="secondary">{ch.subscribers.toLocaleString()} subs</Text>
                      )}
                      <Badge count={ch.videos.length} color="blue" showZero />
                    </Space>
                  ),
                  children: ch.videos.length > 0 ? (
                    <VideoTable videos={ch.videos} production_id={productionId} />
                  ) : (
                    <Text type="secondary">{t("common.noData")}</Text>
                  ),
                }))}
                style={{ marginBottom: 12 }}
              />
            )}
            {research.keywords.length > 0 && (
              <Collapse
                size="small"
                items={research.keywords.map((kw) => ({
                  key: kw.keyword,
                  label: (
                    <Space>
                      <strong>"{kw.keyword}"</strong>
                      <Badge count={kw.videos.length} color="green" showZero />
                      {kw.error && <Tag color="red">{kw.error}</Tag>}
                    </Space>
                  ),
                  children: kw.videos.length > 0 ? (
                    <VideoTable videos={kw.videos} production_id={productionId} />
                  ) : (
                    <Text type="secondary">{t("common.noData")}</Text>
                  ),
                }))}
                style={{ marginBottom: 12 }}
              />
            )}
            {dedupedVideos.length > 0 && (
              <>
                <Title level={5}>{t("research.topVideos")}</Title>
                <VideoTable
                  videos={[...dedupedVideos].sort((a, b) => b.views - a.views).slice(0, 20)}
                  production_id={productionId}
                />
              </>
            )}
          </Card>
        )
      ) : (
        <Alert type="info" message={t("research.skippedNoReason")} showIcon />
      )}

      {/* Trend report section */}
      <Card title={t("research.trendReport")} size="small">
        {!trendReport || trendReport.skipped ? (
          <Alert type="info" message={t("research.trendSkipped")} showIcon />
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {trendReport.summary && (
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label={t("research.summary")}>
                  <Text>{trendReport.summary}</Text>
                </Descriptions.Item>
                {trendReport.recommended_duration_s != null && (
                  <Descriptions.Item label={t("research.recommendedDuration")}>
                    {trendReport.recommended_duration_s}s
                  </Descriptions.Item>
                )}
                {trendReport.posting_schedule && (
                  <Descriptions.Item label={t("research.postingSchedule")}>
                    {trendReport.posting_schedule}
                  </Descriptions.Item>
                )}
              </Descriptions>
            )}
            {trendReport.working_angles.length > 0 && (
              <div>
                <Text strong>{t("research.workingAngles")}</Text>
                <ul style={{ marginTop: 4 }}>
                  {trendReport.working_angles.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
            {trendReport.recommendations.length > 0 && (
              <div>
                <Text strong>{t("research.recommendations")}</Text>
                <ul style={{ marginTop: 4 }}>
                  {trendReport.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {trendReport.title_patterns.length > 0 && (
              <div>
                <Text strong>{t("research.titlePatterns")}</Text>
                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                  {trendReport.title_patterns.map((p, i) => <Tag key={i}>{p}</Tag>)}
                </Space>
              </div>
            )}
            {trendReport.hook_patterns.length > 0 && (
              <div>
                <Text strong>{t("research.hookPatterns")}</Text>
                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                  {trendReport.hook_patterns.map((p, i) => <Tag key={i}>{p}</Tag>)}
                </Space>
              </div>
            )}
            {trendReport.thumbnail_patterns.length > 0 && (
              <div>
                <Text strong>{t("research.thumbnailPatterns")}</Text>
                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                  {trendReport.thumbnail_patterns.map((p, i) => <Tag key={i}>{p}</Tag>)}
                </Space>
              </div>
            )}
          </Space>
        )}
      </Card>
    </Space>
  );
}
