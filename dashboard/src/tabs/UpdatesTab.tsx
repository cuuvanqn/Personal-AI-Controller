import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { List, ListItem } from "@astryxdesign/core/List";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Divider } from "@astryxdesign/core/Divider";
import { PageHeader } from "../components/PageHeader";
import { apiPost, fmtDate, type UpdateStatus } from "../api";

interface Props {
  update: UpdateStatus | null;
  busy: string | null;
  act: (key: string, fn: () => Promise<void>, okText?: string) => Promise<void>;
  onUpdateLoaded: (upd: UpdateStatus) => void;
}

export default function UpdatesTab({ update, busy, act, onUpdateLoaded }: Props) {
  return (
    <VStack gap={6}>
      <PageHeader
        title="Cập nhật Daemon"
        description="Kiểm tra phiên bản phát hành mới và cập nhật binary tự động kèm xác minh SHA-256."
        actions={
          <Button
            label="Kiểm tra cập nhật"
            variant="secondary"
            size="sm"
            isLoading={busy === "update-check"}
            onClick={() =>
              act("update-check", async () => {
                const res = await apiPost<UpdateStatus>("/api/update/check");
                onUpdateLoaded(res);
              })
            }
          />
        }
      />

      {!update ? (
        <Card padding={4}>
          <EmptyState
            title="Chưa tải được trạng thái cập nhật"
            description="Kiểm tra kết nối tới daemon hoặc nhập Auth Token ở đầu trang."
          />
        </Card>
      ) : (
        <VStack gap={4}>
          <Card padding={0}>
            <List hasDividers edge="bleed">
              <ListItem
                label="Phiên bản đang chạy"
                endContent={<Badge variant="neutral" label={`v${update.currentVersion}`} />}
              />
              <ListItem
                label="Trạng thái cập nhật"
                endContent={
                  update.updateAvailable && update.latestVersion ? (
                    <Badge
                      variant={update.mandatory ? "error" : "success"}
                      label={`Có bản mới: v${update.latestVersion}${update.mandatory ? " (bắt buộc)" : ""}`}
                    />
                  ) : (
                    <Badge variant="success" label="Đã là bản mới nhất" />
                  )
                }
              />
              <ListItem
                label="Chế độ chạy"
                endContent={
                  <Text type="supporting">
                    {update.isCompiledBinary
                      ? "Binary độc lập (hỗ trợ tự cập nhật)"
                      : "Chế độ phát triển (Bun dev — chỉ thông báo)"}
                  </Text>
                }
              />
              <ListItem
                label="Kiểm tra lần cuối"
                endContent={<Text type="supporting">{fmtDate(update.lastCheckedAt)}</Text>}
              />
              {update.sha256 && (
                <ListItem
                  label="Mã băm SHA-256"
                  description={
                    <Text type="supporting">
                      <span className="dash-mono">{update.sha256}</span>
                    </Text>
                  }
                />
              )}
            </List>
          </Card>

          {update.lastError && (
            <Card padding={4}>
              <Text type="supporting">Lỗi kiểm tra gần nhất: {update.lastError}</Text>
            </Card>
          )}

          {update.updateAvailable && (
            <Card padding={5}>
              <VStack gap={4}>
                <HStack justify="between" align="center" wrap="wrap" gap={2}>
                  <Text weight="semibold">Ghi chú phát hành v{update.latestVersion}</Text>
                  <Button
                    label="Cập nhật ngay"
                    variant="primary"
                    size="sm"
                    isDisabled={!update.isCompiledBinary}
                    isLoading={busy === "update-apply"}
                    onClick={() =>
                      act(
                        "update-apply",
                        async () => {
                          await apiPost("/api/update/apply");
                        },
                        "Đang tải và áp dụng bản cập nhật — daemon sẽ khởi động lại."
                      )
                    }
                  />
                </HStack>
                <Divider />
                {update.changelog ? (
                  <Markdown headingLevelStart={3}>{update.changelog}</Markdown>
                ) : (
                  <Text type="supporting">Bản phát hành này không kèm ghi chú chi tiết.</Text>
                )}
              </VStack>
            </Card>
          )}
        </VStack>
      )}
    </VStack>
  );
}
