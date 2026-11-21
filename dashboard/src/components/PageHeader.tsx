import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Divider } from "@astryxdesign/core/Divider";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <VStack gap={3}>
      <HStack justify="between" align="center" wrap="wrap" gap={3}>
        <VStack gap={1}>
          <Heading level={1}>{title}</Heading>
          {description && <Text type="supporting">{description}</Text>}
        </VStack>
        {actions && <HStack gap={2} wrap="wrap" align="center">{actions}</HStack>}
      </HStack>
      <Divider />
    </VStack>
  );
}
