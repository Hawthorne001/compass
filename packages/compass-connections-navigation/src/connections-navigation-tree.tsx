import React, { useCallback, useMemo } from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import { getVirtualTreeItems } from './tree-data';
import { ROW_HEIGHT } from './constants';
import type { Actions } from './constants';
import { VirtualTree } from './virtual-list/virtual-list';
import type { OnDefaultAction } from './virtual-list/virtual-list';
import { NavigationItem } from './navigation-item';
import type {
  SidebarTreeItem,
  SidebarActionableItem,
  Connection,
} from './tree-data';
import type { ItemAction, ItemSeparator } from '@mongodb-js/compass-components';
import {
  VisuallyHidden,
  css,
  spacing,
  useId,
} from '@mongodb-js/compass-components';
import type { WorkspaceTab } from '@mongodb-js/compass-workspaces';
import { usePreference } from 'compass-preferences-model/provider';
import type { NavigationItemActions } from './item-actions';
import {
  collectionItemActions,
  connectedConnectionItemActions,
  databaseItemActions,
  notConnectedConnectionItemActions,
} from './item-actions';
import { ConnectionStatus } from '@mongodb-js/compass-connections/provider';

const MCContainer = css({
  display: 'flex',
  flex: '1 0 auto',
  height: `calc(100% - ${spacing[1600]}px - ${spacing[200]}px)`,
});

const SCContainer = css({
  display: 'flex',
  flex: '1 0 auto',
  height: 0,
});

export interface ConnectionsNavigationTreeProps {
  connections: Connection[];
  activeWorkspace: WorkspaceTab | null;
  expanded: Record<string, false | Record<string, boolean>>;
  onItemExpand(item: SidebarActionableItem, isExpanded: boolean): void;
  onItemAction(item: SidebarActionableItem, action: Actions): void;
}

const ConnectionsNavigationTree: React.FunctionComponent<
  ConnectionsNavigationTreeProps
> = ({
  connections,
  activeWorkspace,
  expanded,
  onItemExpand,
  onItemAction,
}) => {
  const preferencesShellEnabled = usePreference('enableShell');
  const preferencesReadOnly = usePreference('readOnly');
  const isSingleConnection = !usePreference(
    'enableNewMultipleConnectionSystem'
  );
  const isRenameCollectionEnabled = usePreference(
    'enableRenameCollectionModal'
  );

  const id = useId();

  const treeData = useMemo(() => {
    return getVirtualTreeItems({
      connections,
      isSingleConnection,
      expandedItems: expanded,
      preferencesReadOnly,
      preferencesShellEnabled,
    });
  }, [
    connections,
    isSingleConnection,
    expanded,
    preferencesReadOnly,
    preferencesShellEnabled,
  ]);

  const onDefaultAction: OnDefaultAction<SidebarActionableItem> = useCallback(
    (item, evt) => {
      if (item.type === 'connection') {
        if (item.connectionStatus === ConnectionStatus.Connected) {
          onItemAction(item, 'select-connection');
        } else if (
          item.connectionStatus === ConnectionStatus.Disconnected ||
          item.connectionStatus === ConnectionStatus.Failed
        ) {
          onItemAction(item, 'connection-connect');
        }
      } else if (item.type === 'database') {
        onItemAction(item, 'select-database');
      } else {
        if (evt.metaKey || evt.ctrlKey) {
          onItemAction(item, 'open-in-new-tab');
        } else {
          onItemAction(item, 'select-collection');
        }
      }
    },
    [onItemAction]
  );

  const activeItemId = useMemo(() => {
    if (activeWorkspace) {
      // Collection or Collections List (of a database)
      if (
        activeWorkspace.type === 'Collection' ||
        activeWorkspace.type === 'Collections'
      ) {
        return `${activeWorkspace.connectionId}.${activeWorkspace.namespace}`;
      }
      // Database List (of a connection)
      if (activeWorkspace.type === 'Databases' && !isSingleConnection) {
        return activeWorkspace.connectionId;
      }
    }
  }, [activeWorkspace, isSingleConnection]);

  const getCollapseAfterForConnectedItem = useCallback(
    (actions: NavigationItemActions) => {
      const [firstAction, secondAction] = actions;

      const actionCanBeShownInline = (
        action: NavigationItemActions[number]
      ): boolean => {
        if (typeof (action as ItemSeparator).separator !== 'undefined') {
          return false;
        }

        return ['create-database', 'open-shell'].includes(
          (action as ItemAction<Actions>).action
        );
      };

      // this is the normal case for a connection that is writable and when we
      // also have shell enabled
      if (
        actionCanBeShownInline(firstAction) &&
        actionCanBeShownInline(secondAction)
      ) {
        return 2;
      }

      // this will happen when the either the connection is not writable or the
      // preference is readonly, or shell is not enabled in which case we either
      // do not show create-database action or open-shell action
      if (
        actionCanBeShownInline(firstAction) ||
        actionCanBeShownInline(secondAction)
      ) {
        return 1;
      }

      return 0;
    },
    []
  );

  const getItemActionsAndConfig = useCallback(
    (item: SidebarTreeItem) => {
      switch (item.type) {
        case 'placeholder':
          return {
            actions: [],
          };
        case 'connection': {
          if (item.connectionStatus === ConnectionStatus.Connected) {
            const actions = connectedConnectionItemActions({
              hasWriteActionsDisabled: item.hasWriteActionsDisabled,
              isShellEnabled: item.isShellEnabled,
              connectionInfo: item.connectionInfo,
              isPerformanceTabSupported: item.isPerformanceTabSupported,
            });
            return {
              actions: actions,
              config: {
                collapseAfter: getCollapseAfterForConnectedItem(actions),
              },
            };
          } else {
            return {
              actions: notConnectedConnectionItemActions({
                connectionInfo: item.connectionInfo,
              }),
              config: {
                collapseAfter: 0,
              },
            };
          }
        }
        case 'database':
          return {
            actions: databaseItemActions({
              hasWriteActionsDisabled: item.hasWriteActionsDisabled,
            }),
          };
        default:
          return {
            actions: collectionItemActions({
              hasWriteActionsDisabled: item.hasWriteActionsDisabled,
              type: item.type,
              isRenameCollectionEnabled,
            }),
          };
      }
    },
    [isRenameCollectionEnabled, getCollapseAfterForConnectedItem]
  );

  const isTestEnv = process.env.NODE_ENV === 'test';

  return (
    <div className={isSingleConnection ? SCContainer : MCContainer}>
      <VisuallyHidden id={id}>Databases and Collections</VisuallyHidden>
      <AutoSizer disableWidth={isTestEnv} disableHeight={isTestEnv}>
        {({ width = isTestEnv ? 1024 : '', height = isTestEnv ? 768 : '' }) => (
          <VirtualTree<SidebarTreeItem>
            dataTestId="sidebar-navigation-tree"
            activeItemId={activeItemId}
            items={treeData}
            width={width}
            height={height}
            itemHeight={ROW_HEIGHT}
            onDefaultAction={onDefaultAction}
            onItemAction={onItemAction}
            onItemExpand={onItemExpand}
            getItemActions={getItemActionsAndConfig}
            getItemKey={(item) => item.id}
            renderItem={({
              item,
              isActive,
              isFocused,
              onItemAction,
              onItemExpand,
              getItemActions,
            }) => {
              return (
                <NavigationItem
                  item={item}
                  isActive={isActive}
                  isFocused={isFocused}
                  getItemActions={getItemActions}
                  onItemExpand={onItemExpand}
                  onItemAction={onItemAction}
                />
              );
            }}
          />
        )}
      </AutoSizer>
    </div>
  );
};

export { ConnectionsNavigationTree };
