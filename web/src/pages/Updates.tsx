import { useCallback, useEffect, useState } from "react";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Markdown } from "@astryxdesign/core/Markdown";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { fetchVersions, componentLabel, type VersionRecord } from "../api";

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("vi-VN", { day: "numeric", month: "numeric", year: "numeric" });
}

export default function Updates() {
  const [versions, setVersions] = useState<VersionRecord[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    setVersions(null);
    fetchVersions()
      .then(setVersions)
      .catch(() => setFailed(true));
  }, []);

  useEffect(load, [load]);

  return (
    <Section padding={8}>
      <VStack gap={5} maxWidth={860}>
        <VStack gap={2}>
          <Heading level={1}>Thông báo & cập nhật</Heading>
          <Text type="supporting">
            Mọi phiên bản mới của Otter đều xuất hiện tại đây, lấy trực tiếp từ máy chủ phát hành.
          </Text>
        </VStack>

        {versions === null && !failed && (
          <HStack gap={3}>
            <Spinner />
            <Text>Đang tải danh sách phiên bản…</Text>
          </HStack>
        )}

        {failed && (
          <EmptyState
            title="Chưa tải được danh sách cập nhật"
            description="Máy chủ phát hành đang bận hoặc mạng của bạn chập chờn. Thử lại sau ít phút."
            actions={<Button label="Thử lại" variant="primary" onClick={load} />}
          />
        )}

        {versions !== null && versions.length === 0 && (
          <EmptyState
            title="Chưa có thông báo nào"
            description="Khi có phiên bản mới, thông tin sẽ xuất hiện tại đây."
          />
        )}

        {versions?.map((v, i) => (
          <Card key={`${v.component}-${v.version}-${i}`}>
            <VStack gap={3}>
              <HStack gap={3}>
                <Text weight="semibold">
                  {componentLabel(v.component)} {v.version}
                </Text>
                {i === 0 && <Badge variant="success" label="Mới nhất" />}
                {v.release_date && <Text type="supporting">{formatDate(v.release_date)}</Text>}
              </HStack>
              {v.changelog ? (
                <Markdown headingLevelStart={3}>{v.changelog}</Markdown>
              ) : (
                <Text type="supporting">Bản này không kèm ghi chú thay đổi.</Text>
              )}
              {v.download_url && (
                <Button
                  label="Tải bản này"
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(v.download_url!, "_blank", "noopener")}
                />
              )}
            </VStack>
          </Card>
        ))}
      </VStack>
    </Section>
  );
}
