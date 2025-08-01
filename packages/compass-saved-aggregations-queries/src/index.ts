import React from 'react';
import { registerCompassPlugin } from '@mongodb-js/compass-app-registry';
import { mongoDBInstancesManagerLocator } from '@mongodb-js/compass-app-stores/provider';
import { createLoggerLocator } from '@mongodb-js/compass-logging/provider';
import { telemetryLocator } from '@mongodb-js/compass-telemetry/provider';
import { activatePlugin } from './stores';
import AggregationsQueriesList from './components/aggregations-queries-list';
import type { WorkspacePlugin } from '@mongodb-js/compass-workspaces';
import { workspacesServiceLocator } from '@mongodb-js/compass-workspaces/provider';
import {
  pipelineStorageLocator,
  favoriteQueryStorageAccessLocator,
} from '@mongodb-js/my-queries-storage/provider';
import { preferencesLocator } from 'compass-preferences-model/provider';
import { connectionsLocator } from '@mongodb-js/compass-connections/provider';
import { PluginTabTitleComponent, WorkspaceName } from './plugin-tab-title';

export const WorkspaceTab: WorkspacePlugin<typeof WorkspaceName> = {
  name: WorkspaceName,
  provider: registerCompassPlugin(
    {
      name: WorkspaceName,
      component: function MyQueriesProvider({ children }): any {
        return React.createElement(React.Fragment, null, children);
      },
      activate: activatePlugin,
    },
    {
      connections: connectionsLocator,
      instancesManager: mongoDBInstancesManagerLocator,
      preferencesAccess: preferencesLocator,
      logger: createLoggerLocator('COMPASS-MY-QUERIES-UI'),
      track: telemetryLocator,
      workspaces: workspacesServiceLocator,
      pipelineStorage: pipelineStorageLocator,
      favoriteQueryStorageAccess: favoriteQueryStorageAccessLocator,
    }
  ),
  content: AggregationsQueriesList,
  header: PluginTabTitleComponent,
};
