import React from 'react';
import {
  WorkspaceTab,
  type WorkspaceTabCoreProps,
} from '@mongodb-js/compass-components';
import type { WorkspacePluginProps } from '@mongodb-js/compass-workspaces';

export const WorkspaceName = 'My Queries' as const;

type PluginTabTitleProps = WorkspaceTabCoreProps &
  WorkspacePluginProps<typeof WorkspaceName>;

export function PluginTabTitleComponent(props: PluginTabTitleProps) {
  return (
    <WorkspaceTab
      {...props}
      type={WorkspaceName}
      title={WorkspaceName}
      iconGlyph="CurlyBraces"
    />
  );
}
