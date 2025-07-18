import type { Listenable, Store } from 'reflux';
import Reflux from 'reflux';
import toNS from 'mongodb-ns';
import { findIndex, isEmpty, isEqual } from 'lodash';
import semver from 'semver';
import StateMixin from '@mongodb-js/reflux-state-mixin';
import type { Element } from 'hadron-document';
import HadronDocument, { Document } from 'hadron-document';
import { toJSString, validate } from 'mongodb-query-parser';
import _parseShellBSON, { ParseMode } from '@mongodb-js/shell-bson-parser';
import type { PreferencesAccess } from 'compass-preferences-model/provider';
import { capMaxTimeMSAtPreferenceLimit } from 'compass-preferences-model/provider';
import type { Stage } from '@mongodb-js/explain-plan-helper';
import { ExplainPlan } from '@mongodb-js/explain-plan-helper';
import { EJSON } from 'bson';
import type {
  FavoriteQueryStorage,
  FavoriteQueryStorageAccess,
  RecentQueryStorage,
  RecentQueryStorageAccess,
} from '@mongodb-js/my-queries-storage/provider';

import {
  countDocuments,
  fetchShardingKeys,
  objectContainsRegularExpression,
} from '../utils';

import type { DOCUMENTS_STATUSES } from '../constants/documents-statuses';
import {
  DOCUMENTS_STATUS_ERROR,
  DOCUMENTS_STATUS_FETCHED_CUSTOM,
  DOCUMENTS_STATUS_FETCHED_INITIAL,
  DOCUMENTS_STATUS_FETCHED_PAGINATION,
  DOCUMENTS_STATUS_FETCHING,
  DOCUMENTS_STATUS_INITIAL,
} from '../constants/documents-statuses';

import type { UpdatePreview } from 'mongodb-data-service';
import type { GridStore, TableHeaderType } from './grid-store';
import configureGridStore from './grid-store';
import type { TypeCastMap } from 'hadron-type-checker';
import type AppRegistry from '@mongodb-js/compass-app-registry';
import type { ActivateHelpers } from '@mongodb-js/compass-app-registry';
import { BaseRefluxStore } from './base-reflux-store';
import { openToast, showConfirmation } from '@mongodb-js/compass-components';
import {
  openBulkDeleteFailureToast,
  openBulkDeleteProgressToast,
  openBulkDeleteSuccessToast,
  openBulkUpdateFailureToast,
  openBulkUpdateProgressToast,
  openBulkUpdateSuccessToast,
} from '../components/bulk-actions-toasts';
import type { DataService } from '../utils/data-service';
import type {
  Collection,
  MongoDBInstance,
} from '@mongodb-js/compass-app-stores/provider';
import configureActions from '../actions';
import type { Logger } from '@mongodb-js/compass-logging/provider';
import { mongoLogId } from '@mongodb-js/compass-logging/provider';
import type { CollectionTabPluginMetadata } from '@mongodb-js/compass-collection';
import type { FieldStoreService } from '@mongodb-js/compass-field-store';
import type {
  ConnectionInfoRef,
  ConnectionScopedAppRegistry,
} from '@mongodb-js/compass-connections/provider';
import type { Query, QueryBarService } from '@mongodb-js/compass-query-bar';
import type { TrackFunction } from '@mongodb-js/compass-telemetry';
import type { MongoServerError } from 'mongodb';

export type BSONObject = TypeCastMap['Object'];
export type BSONArray = TypeCastMap['Array'];
type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export type EmittedAppRegistryEvents =
  | 'open-import'
  | 'open-export'
  | 'document-deleted'
  | 'document-inserted';

export type CrudActions = {
  drillDown(
    doc: Document,
    element: Element,
    editParams?: {
      colId: string;
      rowIndex: number;
    }
  ): void;
  updateDocument(doc: Document): Promise<void>;
  removeDocument(doc: Document): Promise<void>;
  replaceDocument(doc: Document): Promise<void>;
  openInsertDocumentDialog(doc: BSONObject, cloned: boolean): Promise<void>;
  copyToClipboard(doc: Document): void; //XXX
  openBulkDeleteDialog(): void;
  runBulkUpdate(): Promise<void>;
  closeBulkDeleteDialog(): void;
  runBulkDelete(): Promise<void>;
  openDeleteQueryExportToLanguageDialog(): void;
  saveUpdateQuery(name: string): Promise<void>;
};

export type DocumentView = 'List' | 'JSON' | 'Table';

const INITIAL_BULK_UPDATE_TEXT = `{
  $set: {

  },
}`;

export const fetchDocuments: (
  dataService: DataService,
  track: TrackFunction,
  serverVersion: string,
  isDataLake: boolean,
  ...args: Parameters<DataService['find']>
) => Promise<HadronDocument[]> = async (
  dataService: DataService,
  track: TrackFunction,
  serverVersion,
  isDataLake,
  ns,
  filter,
  options,
  executionOptions
) => {
  const canCalculateDocSize =
    // $bsonSize is only supported for mongodb >= 4.4.0
    semver.gte(serverVersion, '4.4.0') &&
    // ADF doesn't support $bsonSize
    !isDataLake &&
    // Accessing $$ROOT is not possible with CSFLE
    ['disabled', 'unavailable', undefined].includes(
      dataService?.getCSFLEMode?.()
    ) &&
    // User provided their own projection, we can handle this in some cases, but
    // it's hard to get right, so we will just skip this case
    isEmpty(options?.projection);

  const modifiedOptions = {
    ...options,
    projection: canCalculateDocSize
      ? { _id: 0, __doc: '$$ROOT', __size: { $bsonSize: '$$ROOT' } }
      : options?.projection,
  };

  try {
    let uuidSubtype3Count = 0;
    let uuidSubtype4Count = 0;
    const docs = (
      await dataService.find(ns, filter, modifiedOptions, executionOptions)
    ).map((doc) => {
      const { __doc, __size, ...rest } = doc;
      let hadronDoc: HadronDocument;
      if (__doc && __size && Object.keys(rest).length === 0) {
        hadronDoc = new HadronDocument(__doc);
        hadronDoc.size = Number(__size);
      } else {
        hadronDoc = new HadronDocument(doc);
      }
      const { subtype3Count, subtype4Count } = hadronDoc.findUUIDs();
      uuidSubtype3Count += subtype3Count;
      uuidSubtype4Count += subtype4Count;
      return hadronDoc;
    });
    if (uuidSubtype3Count > 0) {
      track('UUID Encountered', { subtype: 3, count: uuidSubtype3Count });
    }
    if (uuidSubtype4Count > 0) {
      track('UUID Encountered', { subtype: 4, count: uuidSubtype4Count });
    }
    return docs;
  } catch (err) {
    // We are handling all the cases where the size calculating projection might
    // not work, but just in case we run into some other environment or use-case
    // that we haven't anticipated, we will try re-running query without the
    // modified projection once more before failing again if this didn't work
    if (canCalculateDocSize && (err as Error).name === 'MongoServerError') {
      return (
        await dataService.find(ns, filter, options, executionOptions)
      ).map((doc) => {
        return new HadronDocument(doc);
      });
    }

    throw err;
  }
};

type CollectionStats = Pick<
  Collection,
  'document_count' | 'storage_size' | 'free_storage_size' | 'avg_document_size'
>;
const extractCollectionStats = (collection: Collection): CollectionStats => {
  const coll = collection.toJSON();
  return {
    document_count: coll.document_count,
    storage_size: coll.storage_size,
    free_storage_size: coll.free_storage_size,
    avg_document_size: coll.avg_document_size,
  };
};

/**
 * Default number of docs per page.
 */
const DEFAULT_NUM_PAGE_DOCS = 25;

/**
 * Error constant.
 */
const ERROR = 'error';

/**
 * Modifying constant.
 */
const MODIFYING = 'modifying';

/**
 * The list view constant.
 */
const LIST = 'List';

/**
 * The delete error message.
 */
const DELETE_ERROR = new Error(
  'Cannot delete documents that do not have an _id field.'
);

/**
 * The empty update error message.
 */
const EMPTY_UPDATE_ERROR = new Error(
  'Unable to update, no changes have been made.'
);

/**
 * Default max time ms for the first query which is not getting the value from
 * the query bar.
 */
const DEFAULT_INITIAL_MAX_TIME_MS = 60000;

/**
 * A cap for the maxTimeMS used for countDocuments. This value is used
 * in place of the query maxTimeMS unless that is smaller.
 *
 * Due to the limit of 20 documents the batch of data for the query is usually
 * ready sooner than the count.
 *
 * We want to make sure `count` does not hold back the query results for too
 * long after docs are returned.
 */
const COUNT_MAX_TIME_MS_CAP = 5000;

/**
 * The key we use to persist the user selected maximum documents per page for
 * other tabs or for the next application start.
 * Exported only for test purpose
 */
export const MAX_DOCS_PER_PAGE_STORAGE_KEY = 'compass_crud-max_docs_per_page';

export type CrudStoreOptions = Pick<
  CollectionTabPluginMetadata,
  | 'query'
  | 'isReadonly'
  | 'namespace'
  | 'isTimeSeries'
  | 'isSearchIndexesSupported'
> & {
  noRefreshOnConfigure?: boolean;
};

export type InsertCSFLEState = {
  state:
    | 'none'
    | 'no-known-schema'
    | 'incomplete-schema-for-cloned-doc'
    | 'has-known-schema'
    | 'csfle-disabled';
  encryptedFields?: string[];
};

export type WriteError = {
  message: string;
  info?: Record<string, unknown>;
};

type InsertState = {
  doc: null | Document;
  jsonDoc: null | string;
  error?: WriteError;
  csfleState: InsertCSFLEState;
  mode: 'modifying' | 'error';
  jsonView: boolean;
  isOpen: boolean;
  isCommentNeeded: boolean;
};

type BulkUpdateState = {
  isOpen: boolean;
  updateText: string;
  preview: UpdatePreview;
  syntaxError?: Error;
  serverError?: Error;
  previewAbortController?: AbortController;
  affected?: number;
};

export type TableState = {
  doc: Document | null;
  path: (string | number)[];
  types: TableHeaderType[];
  editParams: null | {
    colId: string | number;
    rowIndex: number;
  };
};

export type BulkDeleteState = {
  previews: Document[];
  status: 'open' | 'closed' | 'in-progress';
  affected?: number;
};

type CrudState = {
  ns: string;
  collection: string;
  abortController: AbortController | null;
  error: Error | null;
  docs: Document[] | null;
  start: number;
  end: number;
  page: number;
  version: string;
  view: DocumentView;
  count: number | null;
  insert: InsertState;
  bulkUpdate: BulkUpdateState;
  table: TableState;
  isDataLake: boolean;
  isReadonly: boolean;
  isTimeSeries: boolean;
  status: DOCUMENTS_STATUSES;
  debouncingLoad: boolean;
  loadingCount: boolean;
  shardKeys: null | BSONObject;
  resultId: number;
  isWritable: boolean;
  instanceDescription: string;
  isCollectionScan?: boolean;
  isSearchIndexesSupported: boolean;
  isUpdatePreviewSupported: boolean;
  bulkDelete: BulkDeleteState;
  docsPerPage: number;
  collectionStats: CollectionStats | null;
};

type CrudStoreActionsOptions = {
  actions: {
    [key in keyof CrudActions]: Listenable;
  };
};

class CrudStoreImpl
  extends BaseRefluxStore<CrudStoreOptions & CrudStoreActionsOptions>
  implements CrudActions
{
  mixins = [StateMixin.store<CrudState>()];
  listenables: unknown[];

  // Should this be readonly? The existence of setState would imply that...
  // readonly state!: Readonly<CrudState>
  state!: CrudState;
  setState!: (newState: Partial<CrudState>) => void;
  dataService: DataService;
  preferences: PreferencesAccess;
  localAppRegistry: Pick<AppRegistry, 'on' | 'emit' | 'removeListener'>;
  favoriteQueriesStorage?: FavoriteQueryStorage;
  recentQueriesStorage?: RecentQueryStorage;
  fieldStoreService: FieldStoreService;
  logger: Logger;
  track: TrackFunction;
  connectionInfoRef: ConnectionInfoRef;
  instance: MongoDBInstance;
  connectionScopedAppRegistry: ConnectionScopedAppRegistry<EmittedAppRegistryEvents>;
  queryBar: QueryBarService;
  collection: Collection;

  constructor(
    options: CrudStoreOptions & CrudStoreActionsOptions,
    services: Pick<
      DocumentsPluginServices,
      | 'instance'
      | 'dataService'
      | 'localAppRegistry'
      | 'preferences'
      | 'logger'
      | 'track'
      | 'connectionInfoRef'
      | 'fieldStoreService'
      | 'connectionScopedAppRegistry'
      | 'queryBar'
      | 'collection'
    > & {
      favoriteQueryStorage?: FavoriteQueryStorage;
      recentQueryStorage?: RecentQueryStorage;
    }
  ) {
    super(options);
    this.listenables = options.actions as any; // TODO: The types genuinely mismatch here
    this.favoriteQueriesStorage = services.favoriteQueryStorage;
    this.recentQueriesStorage = services.recentQueryStorage;
    this.dataService = services.dataService;
    this.localAppRegistry = services.localAppRegistry;
    this.preferences = services.preferences;
    this.logger = services.logger;
    this.track = services.track;
    this.connectionInfoRef = services.connectionInfoRef;
    this.instance = services.instance;
    this.fieldStoreService = services.fieldStoreService;
    this.connectionScopedAppRegistry = services.connectionScopedAppRegistry;
    this.queryBar = services.queryBar;
    this.collection = services.collection;
  }

  getInitialState(): CrudState {
    const isDataLake = !!this.instance.dataLake.isDataLake;
    const isReadonly = !!this.options.isReadonly;

    return {
      ns: this.options.namespace,
      collection: toNS(this.options.namespace).collection,
      abortController: null,
      error: null,
      docs: [],
      start: 0,
      version: this.instance.build.version,
      end: 0,
      page: 0,
      view: LIST,
      count: null,
      insert: this.getInitialInsertState(),
      bulkUpdate: this.getInitialBulkUpdateState(),
      bulkDelete: this.getInitialBulkDeleteState(),
      table: this.getInitialTableState(),
      isDataLake,
      isReadonly,
      isTimeSeries: !!this.options.isTimeSeries,
      status: DOCUMENTS_STATUS_INITIAL,
      debouncingLoad: false,
      loadingCount: false,
      shardKeys: null,
      resultId: resultId(),
      isWritable: this.instance.isWritable,
      instanceDescription: this.instance.description,
      isCollectionScan: false,
      isSearchIndexesSupported: this.options.isSearchIndexesSupported,
      isUpdatePreviewSupported:
        this.instance.topologyDescription.type !== 'Single',
      docsPerPage: this.getInitialDocsPerPage(),
      collectionStats: extractCollectionStats(this.collection),
    };
  }

  getInitialDocsPerPage(): number {
    const lastUsedDocsPerPageString = localStorage.getItem(
      MAX_DOCS_PER_PAGE_STORAGE_KEY
    );
    const lastUsedDocsPerPage = lastUsedDocsPerPageString
      ? parseInt(lastUsedDocsPerPageString)
      : null;
    return lastUsedDocsPerPage ?? DEFAULT_NUM_PAGE_DOCS;
  }

  /**
   * Get the initial insert state.
   *
   * @returns {Object} The initial insert state.
   */
  getInitialInsertState(): InsertState {
    return {
      doc: null,
      jsonDoc: null,
      csfleState: { state: 'none' },
      mode: MODIFYING,
      jsonView: false,
      isOpen: false,
      isCommentNeeded: true,
    };
  }

  getInitialBulkUpdateState(): BulkUpdateState {
    return {
      isOpen: false,
      updateText: INITIAL_BULK_UPDATE_TEXT,
      preview: {
        changes: [],
      },
      syntaxError: undefined,
      serverError: undefined,
    };
  }

  getInitialBulkDeleteState(): BulkDeleteState {
    return {
      previews: [],
      status: 'closed',
      affected: 0,
    };
  }

  /**
   * Get the initial table state.
   *
   * @returns {Object} The initial table state.
   */
  getInitialTableState(): TableState {
    return {
      doc: null,
      path: [],
      types: [],
      editParams: null,
    };
  }

  /**
   * Returns the current view in the format used for telemetry
   * ('list', 'json', 'table'). Grouped here so that this is easy
   * to update if the labels change at some point.
   */
  modeForTelemetry() {
    return this.state.view.toLowerCase() as Lowercase<DocumentView>;
  }

  /**
   * Copy the document to the clipboard.
   *
   * @param {HadronDocument} doc - The document.
   *
   * @returns {Boolean} If the copy succeeded.
   */
  copyToClipboard(doc: Document) {
    this.track(
      'Document Copied',
      { mode: this.modeForTelemetry() },
      this.connectionInfoRef.current
    );
    const documentEJSON = doc.toEJSON();
    // eslint-disable-next-line no-undef
    void navigator.clipboard.writeText(documentEJSON);
  }

  getWriteError(error: Error): WriteError {
    return {
      message: error.message,
      info: (error as MongoServerError).errInfo,
    };
  }

  updateMaxDocumentsPerPage(docsPerPage: number) {
    const previousDocsPerPage = this.state.docsPerPage;
    localStorage.setItem(MAX_DOCS_PER_PAGE_STORAGE_KEY, String(docsPerPage));
    this.setState({
      docsPerPage,
    });
    if (previousDocsPerPage !== docsPerPage) {
      void this.refreshDocuments();
    }
  }

  /**
   * Remove the provided document from the collection.
   *
   * @param {Document} doc - The hadron document.
   */
  async removeDocument(doc: Document) {
    this.track(
      'Document Deleted',
      { mode: this.modeForTelemetry() },
      this.connectionInfoRef.current
    );
    const id = doc.getId();
    if (id !== undefined) {
      doc.onRemoveStart();
      try {
        await this.dataService.deleteOne(this.state.ns, { _id: id } as any);
        // emit on the document(list view) and success state(json view)
        doc.onRemoveSuccess();
        const payload = { view: this.state.view, ns: this.state.ns };
        this.localAppRegistry.emit('document-deleted', payload);
        this.connectionScopedAppRegistry.emit('document-deleted', payload);
        const index = this.findDocumentIndex(doc);
        const newDocs = this.state.docs
          ? [...this.state.docs]
          : this.state.docs;
        newDocs?.splice(index, 1);
        this.setState({
          docs: newDocs,
          count: this.state.count === null ? null : this.state.count - 1,
          end: Math.max(this.state.end - 1, 0),
        });
      } catch (error) {
        // emit on the document(list view) and success state(json view)
        doc.onRemoveError(error as Error);
        this.trigger(this.state);
      }
    } else {
      doc.onRemoveError(DELETE_ERROR);
      this.trigger(this.state);
    }
  }

  /**
   * Ensure that updating the given document is allowed
   * (currently only in the sense that for CSFLE-enabled clients,
   * there is no risk of writing back unencrypted data).
   * If this is not the case, returns false and emit `update-error`
   * on the document object.
   *
   * @param {string} ns The collection namespace
   * @param {Document} doc A HadronDocument instance
   * @returns {boolean} Whether updating is allowed.
   */
  async _verifyUpdateAllowed(ns: string, doc: Document) {
    if (this.dataService.getCSFLEMode?.() === 'enabled') {
      // Editing the document and then being informed that
      // doing so is disallowed might not be great UX, but
      // since we are mostly targeting typical FLE2 use cases,
      // it's probably not worth spending too much time on this.
      const isAllowed = await this.dataService.isUpdateAllowed?.(
        ns,
        doc.generateOriginalObject()
      );
      if (!isAllowed) {
        doc.onUpdateError(
          new Error(
            'Update blocked as it could unintentionally write unencrypted data due to a missing or incomplete schema.'
          )
        );
        return false;
      }
    }
    return true;
  }

  /**
   * Update the provided document unless the elements being changed were
   * changed in the background. If the elements being changed were changed
   * in the background, block the update.
   *
   * @param {Document} doc - The hadron document.
   */
  async updateDocument(doc: Document) {
    this.track(
      'Document Updated',
      { mode: this.modeForTelemetry() },
      this.connectionInfoRef.current
    );
    try {
      doc.onUpdateStart();
      // We add the shard keys here, if there are any, because that is
      // required for updated documents in sharded collections.
      const { query, updateDoc } =
        doc.generateUpdateUnlessChangedInBackgroundQuery(
          // '.' in shard keys means nested doc
          {
            alwaysIncludeKeys: Object.keys(this.state.shardKeys || {}).map(
              (key) => key.split('.')
            ),
          }
        );
      this.logger.debug('Performing findOneAndUpdate', { query, updateDoc });

      if (Object.keys(updateDoc).length === 0) {
        doc.onUpdateError(EMPTY_UPDATE_ERROR);
        return;
      }

      if (!(await this._verifyUpdateAllowed(this.state.ns, doc))) {
        // _verifyUpdateAllowed emitted update-error
        return;
      }
      const [error, d] = await findAndModifyWithFLEFallback(
        this.dataService,
        this.state.ns,
        query,
        updateDoc,
        'update'
      );

      if (error) {
        if (
          error.codeName === 'InvalidPipelineOperator' &&
          error.message.match(/\$[gs]etField/)
        ) {
          const nbsp = '\u00a0';
          error.message += ` (Updating fields whose names contain dots or start with $ require MongoDB${nbsp}5.0 or above.)`;
        }
        doc.onUpdateError(error as Error);
      } else if (d) {
        doc.onUpdateSuccess(d);
        const index = this.findDocumentIndex(doc);
        const newDocs = this.state.docs
          ? [...this.state.docs]
          : this.state.docs;
        newDocs?.splice(index, 1, new HadronDocument(d));
        this.setState({
          docs: newDocs,
        });
      } else {
        doc.onUpdateBlocked();
      }
    } catch (err: any) {
      doc.onUpdateError(
        new Error(
          `An error occured when attempting to update the document: ${String(
            err.message
          )}`
        )
      );
    }
  }

  /**
   * Replace the document in the database with the provided document.
   *
   * @param {Document} doc - The hadron document.
   */
  async replaceDocument(doc: Document) {
    this.track(
      'Document Updated',
      { mode: this.modeForTelemetry() },
      this.connectionInfoRef.current
    );
    try {
      doc.onUpdateStart();

      if (!(await this._verifyUpdateAllowed(this.state.ns, doc))) {
        // _verifyUpdateAllowed emitted update-error
        return;
      }

      const object = doc.generateObject();
      const queryKeyInclusionOptions: Mutable<
        Parameters<
          typeof doc.getQueryForOriginalKeysAndValuesForSpecifiedKeys
        >[0]
      > = {
        alwaysIncludeKeys: [
          ['_id'],
          // '.' in shard keys means nested doc
          ...Object.keys(this.state.shardKeys || {}).map((key) =>
            key.split('.')
          ),
        ],
      };

      if (this.dataService.getCSFLEMode?.() === 'enabled') {
        const knownSchemaForCollection =
          await this.dataService.knownSchemaForCollection(this.state.ns);

        // The find/query portion will typically exclude encrypted fields,
        // because those cannot be queried to make sure that the original
        // value matches the current one; however, if we know that the
        // field is equality-searchable, we can (and should) still include it.
        queryKeyInclusionOptions.includableEncryptedKeys =
          knownSchemaForCollection.encryptedFields.equalityQueryableEncryptedFields;

        if (
          object.__safeContent__ &&
          isEqual(
            object.__safeContent__,
            doc.generateOriginalObject().__safeContent__
          ) &&
          knownSchemaForCollection.hasSchema
        ) {
          // SERVER-66662 blocks writes of __safeContent__ for queryable-encryption-enabled
          // collections. We remove it unless it was edited, in which case we assume that the
          // user really knows what they are doing.
          delete object.__safeContent__;
        }
      }

      const query = doc.getQueryForOriginalKeysAndValuesForSpecifiedKeys(
        queryKeyInclusionOptions
      );
      this.logger.debug('Performing findOneAndReplace', { query, object });

      const [error, d] = await findAndModifyWithFLEFallback(
        this.dataService,
        this.state.ns,
        query,
        object,
        'replace'
      );
      if (error) {
        doc.onUpdateError(error as Error);
      } else {
        doc.onUpdateSuccess(d);
        const index = this.findDocumentIndex(doc);
        const newDocs = this.state.docs
          ? [...this.state.docs]
          : this.state.docs;
        newDocs?.splice(index, 1, new HadronDocument(d));
        this.setState({
          docs: newDocs,
        });
      }
    } catch (err: any) {
      doc.onUpdateError(
        new Error(
          `An error occured when attempting to update the document: ${String(
            err.message
          )}`
        )
      );
    }
  }

  /**
   * Set if the default comment should be displayed.
   *
   * @param {Boolean} isCommentNeeded - Is a comment needed or not.
   */
  updateComment(isCommentNeeded: boolean) {
    const insert = { ...this.state.insert, isCommentNeeded };
    this.setState({ insert });
  }

  /**
   * Find the index of the document in the list.
   *
   * @param {Document} doc - The hadron document.
   *
   * @returns {String} Document Index from the list.
   */
  findDocumentIndex(doc: Document) {
    return findIndex(this.state.docs, (d) => {
      return doc.getStringId() === d.getStringId();
    });
  }

  /**
   * When the next page button is clicked, need to load the next 20 documents.
   *
   * @param {Number} page - The page that is being shown.
   */
  async getPage(page: number) {
    const { ns, status, docsPerPage } = this.state;

    if (page < 0) {
      return;
    }

    if (status === DOCUMENTS_STATUS_FETCHING) {
      return;
    }

    const {
      filter,
      limit,
      sort,
      project: projection,
      collation,
      maxTimeMS,
      skip: _skip = 0,
    } = this.queryBar.getLastAppliedQuery('crud');

    const skip = _skip + page * docsPerPage;

    // nextPageCount will be the number of docs to load
    let nextPageCount = docsPerPage;

    // Make sure we don't go past the limit if a limit is set
    if (limit) {
      const remaining = limit - skip;
      if (remaining < 1) {
        return;
      }
      if (remaining < nextPageCount) {
        nextPageCount = remaining;
      }
    }

    const abortController = new AbortController();
    const signal = abortController.signal;

    const opts = {
      skip,
      limit: nextPageCount,
      sort,
      projection,
      collation,
      maxTimeMS: capMaxTimeMSAtPreferenceLimit(this.preferences, maxTimeMS),
      promoteValues: false,
      bsonRegExp: true,
    };

    this.setState({
      status: DOCUMENTS_STATUS_FETCHING,
      abortController,
      error: null,
    });

    const cancelDebounceLoad = this.debounceLoading();

    let error: Error | undefined;
    let documents: HadronDocument[];
    try {
      documents = await fetchDocuments(
        this.dataService,
        this.track,
        this.state.version,
        this.state.isDataLake,
        ns,
        filter ?? {},
        opts as any,
        {
          abortSignal: signal,
        }
      );
    } catch (err: any) {
      documents = [];
      error = err;
    }

    const length = error ? 0 : documents.length;
    this.setState({
      error,
      status: error
        ? DOCUMENTS_STATUS_ERROR
        : DOCUMENTS_STATUS_FETCHED_PAGINATION,
      docs: documents,
      // making sure we don't set start to 1 if length is 0
      start: length === 0 ? 0 : skip + 1,
      end: skip + length,
      page,
      table: this.getInitialTableState(),
      resultId: resultId(),
      abortController: null,
    });
    void this.fieldStoreService.updateFieldsFromDocuments(this.state.ns, [
      documents[0]?.generateObject(),
    ]);

    cancelDebounceLoad();
  }

  /**
   * Closing the insert document dialog just resets the state to the default.
   */
  closeInsertDocumentDialog() {
    this.setState({
      insert: this.getInitialInsertState(),
    });
  }

  /**
   * Closing the bulk update dialog just resets the state to the default.
   */
  closeBulkUpdateModal() {
    this.setState({
      bulkUpdate: {
        ...this.state.bulkUpdate,
        isOpen: false,
      },
    });
  }

  /**
   * Open the insert document dialog.
   *
   * @param {Object} doc - The document to insert.
   * @param {Boolean} clone - Whether this is a clone operation.
   */
  async openInsertDocumentDialog(doc: BSONObject, clone = false) {
    const hadronDoc = new HadronDocument(doc);

    if (clone) {
      this.track(
        'Document Cloned',
        { mode: this.modeForTelemetry() },
        this.connectionInfoRef.current
      );
      // We need to remove the _id or we will get an duplicate key error on
      // insert, and we currently do not allow editing of the _id field.
      for (const element of hadronDoc.elements) {
        if (element.currentKey === '_id') {
          hadronDoc.elements.remove(element);
          break;
        }
      }
    }

    const csfleState: InsertState['csfleState'] = { state: 'none' };
    const dataServiceCSFLEMode = this.dataService.getCSFLEMode?.();
    if (dataServiceCSFLEMode === 'enabled') {
      // Show a warning if this is a CSFLE-enabled connection but this
      // collection does not have a schema.
      const {
        hasSchema,
        encryptedFields: { encryptedFields },
      } = await this.dataService.knownSchemaForCollection(this.state.ns);
      if (encryptedFields.length > 0) {
        // This is for displaying encrypted fields to the user. We do not really
        // need to worry about the distinction between '.' as a nested-field
        // indicator and '.' as a literal part of a field name here, esp. since
        // automatic Queryable Encryption does not support '.' in field names at all.
        csfleState.encryptedFields = encryptedFields.map((field) =>
          field.join('.')
        );
      }
      if (!hasSchema) {
        csfleState.state = 'no-known-schema';
      } else if (
        !(await this.dataService.isUpdateAllowed?.(this.state.ns, doc))
      ) {
        csfleState.state = 'incomplete-schema-for-cloned-doc';
      } else {
        csfleState.state = 'has-known-schema';
      }
    } else if (dataServiceCSFLEMode === 'disabled') {
      csfleState.state = 'csfle-disabled';
    }

    const jsonDoc = hadronDoc.toEJSON();

    this.setState({
      insert: {
        doc: hadronDoc,
        jsonDoc: jsonDoc,
        jsonView: true,
        error: undefined,
        csfleState,
        mode: MODIFYING,
        isOpen: true,
        isCommentNeeded: true,
      },
    });
  }

  async openBulkUpdateModal(updateText?: string) {
    this.track(
      'Bulk Update Opened',
      {
        isUpdatePreviewSupported: this.state.isUpdatePreviewSupported,
      },
      this.connectionInfoRef.current
    );

    await this.updateBulkUpdatePreview(updateText ?? INITIAL_BULK_UPDATE_TEXT);
    this.setState({
      bulkUpdate: {
        ...this.state.bulkUpdate,
        isOpen: true,
      },
    });
  }

  async updateBulkUpdatePreview(updateText: string) {
    if (this.state.bulkUpdate.previewAbortController) {
      this.state.bulkUpdate.previewAbortController.abort();
    }

    // Don't try and calculate the update preview if we know it won't work. Just
    // see if the update will parse.
    if (!this.state.isUpdatePreviewSupported) {
      try {
        parseShellBSON(updateText);
      } catch (err: any) {
        this.setState({
          bulkUpdate: {
            ...this.state.bulkUpdate,
            updateText,
            preview: {
              changes: [],
            },
            serverError: undefined,
            syntaxError: err,
            previewAbortController: undefined,
          },
        });
        return;
      }

      // if there's no syntax error, then just clear it
      this.setState({
        bulkUpdate: {
          ...this.state.bulkUpdate,
          updateText,
          preview: {
            changes: [],
          },
          serverError: undefined,
          syntaxError: undefined,
          previewAbortController: undefined,
        },
      });

      return;
    }

    const abortController = new AbortController();

    // set the abort controller in the state before we start doing anything so
    // that other calls can see it
    this.setState({
      bulkUpdate: {
        ...this.state.bulkUpdate,
        previewAbortController: abortController,
      },
    });

    let update: BSONObject | BSONObject[];
    try {
      update = parseShellBSON(updateText);
    } catch (err: any) {
      if (abortController.signal.aborted) {
        // ignore this result because it is stale
        return;
      }

      this.setState({
        bulkUpdate: {
          ...this.state.bulkUpdate,
          updateText,
          preview: {
            changes: [],
          },
          serverError: undefined,
          syntaxError: err,
          previewAbortController: undefined,
        },
      });

      return;
    }

    if (abortController.signal.aborted) {
      // don't kick off an expensive query if we're already aborted anyway
      return;
    }

    const { ns } = this.state;
    const { filter = {} } = this.queryBar.getLastAppliedQuery('crud');

    let preview;
    try {
      preview = await this.dataService.previewUpdate(ns, filter, update, {
        sample: 3,
        abortSignal: abortController.signal,
      });
    } catch (err: any) {
      if (abortController.signal.aborted) {
        // ignore this result because it is stale
        return;
      }

      this.setState({
        bulkUpdate: {
          ...this.state.bulkUpdate,
          updateText,
          preview: {
            changes: [],
          },
          serverError: err,
          syntaxError: undefined,
          previewAbortController: undefined,
        },
      });

      return;
    }

    if (abortController.signal.aborted) {
      // ignore this result because it is stale
      return;
    }

    this.setState({
      bulkUpdate: {
        ...this.state.bulkUpdate,
        updateText,
        preview,
        serverError: undefined,
        syntaxError: undefined,
        previewAbortController: undefined,
      },
    });
  }

  async runBulkUpdate() {
    this.track(
      'Bulk Update Executed',
      {
        isUpdatePreviewSupported: this.state.isUpdatePreviewSupported,
      },
      this.connectionInfoRef.current
    );

    this.closeBulkUpdateModal();

    // keep the filter count around for the duration of the toast
    this.setState({
      bulkUpdate: {
        ...this.state.bulkUpdate,
        affected: this.state.count ?? undefined,
      },
    });

    const { ns } = this.state;
    const { filter = {} } = this.queryBar.getLastAppliedQuery('crud');
    let update;
    try {
      update = parseShellBSON(this.state.bulkUpdate.updateText);
    } catch {
      // If this couldn't parse then the update button should have been
      // disabled. So if we get here it is a race condition and ignoring is
      // probably OK - the button will soon appear disabled to the user anyway.
      return;
    }

    await this.recentQueriesStorage?.saveQuery({
      _ns: this.state.ns,
      filter,
      update,
    });

    openBulkUpdateProgressToast({
      affectedDocuments: this.state.bulkUpdate.affected,
    });

    try {
      await this.dataService.updateMany(ns, filter, update);

      openBulkUpdateSuccessToast({
        affectedDocuments: this.state.bulkUpdate.affected,
        onRefresh: () => void this.refreshDocuments(),
      });
    } catch (err: any) {
      openBulkUpdateFailureToast({
        affectedDocuments: this.state.bulkUpdate.affected,
        error: err as Error,
      });

      this.logger.log.error(
        mongoLogId(1_001_000_269),
        'Bulk Update Documents',
        `Update operation failed: ${err.message}`,
        err
      );
    }
  }

  /**
   * Open an import file dialog from compass-import-export-plugin.
   * Emits a global app registry event the plugin listens to.
   */
  openImportFileDialog() {
    this.connectionScopedAppRegistry.emit('open-import', {
      namespace: this.state.ns,
      origin: 'empty-state',
    });
  }

  /**
   * Open an export file dialog from compass-import-export-plugin.
   * Emits a global app registry event the plugin listens to.
   */
  openExportFileDialog(exportFullCollection?: boolean) {
    const { filter, project, collation, limit, skip, sort } =
      this.queryBar.getLastAppliedQuery('crud');

    this.connectionScopedAppRegistry.emit('open-export', {
      namespace: this.state.ns,
      query: { filter, project, collation, limit, skip, sort },
      exportFullCollection,
      origin: 'crud-toolbar',
    });
  }

  /**
   * Switch between list and JSON views when inserting a document through Insert Document modal.
   *
   * Also modifies doc and jsonDoc states to keep accurate data for each view.
   * @param {String} view - view we are switching to.
   */
  toggleInsertDocument(view: DocumentView) {
    if (view === 'JSON') {
      const jsonDoc = this.state.insert.doc?.toEJSON();

      this.setState({
        insert: {
          doc: this.state.insert.doc,
          jsonView: true,
          jsonDoc: jsonDoc ?? null,
          error: undefined,
          csfleState: this.state.insert.csfleState,
          mode: MODIFYING,
          isOpen: true,
          isCommentNeeded: this.state.insert.isCommentNeeded,
        },
      });
    } else {
      let hadronDoc;

      if (this.state.insert.jsonDoc === '') {
        hadronDoc = this.state.insert.doc;
      } else {
        hadronDoc = HadronDocument.FromEJSON(this.state.insert.jsonDoc ?? '');
      }

      this.setState({
        insert: {
          doc: hadronDoc,
          jsonView: false,
          jsonDoc: this.state.insert.jsonDoc,
          error: undefined,
          csfleState: this.state.insert.csfleState,
          mode: MODIFYING,
          isOpen: true,
          isCommentNeeded: this.state.insert.isCommentNeeded,
        },
      });
    }
  }

  /**
   * Toggle just the jsonView insert state.
   *
   * @param {String} view - view we are switching to.
   */
  toggleInsertDocumentView(view: DocumentView) {
    const jsonView = view === 'JSON';
    this.setState({
      insert: {
        doc: new Document({}),
        jsonDoc: this.state.insert.jsonDoc,
        jsonView: jsonView,
        error: undefined,
        csfleState: this.state.insert.csfleState,
        mode: MODIFYING,
        isOpen: true,
        isCommentNeeded: this.state.insert.isCommentNeeded,
      },
    });
  }

  /**
   * As we are editing a JSON document in Insert Document Dialog, update the
   * state with the inputed json data.
   *
   * @param {String} value - JSON string we are updating.
   */
  updateJsonDoc(value: string | null) {
    this.setState({
      insert: {
        doc: new Document({}),
        jsonDoc: value,
        jsonView: true,
        error: undefined,
        csfleState: this.state.insert.csfleState,
        mode: MODIFYING,
        isOpen: true,
        isCommentNeeded: this.state.insert.isCommentNeeded,
      },
    });
  }

  /**
   * Insert a single document.
   */
  async insertMany() {
    try {
      const docs = HadronDocument.FromEJSONArray(
        this.state.insert.jsonDoc ?? ''
      ).map((doc) => doc.generateObject());
      this.track(
        'Document Inserted',
        {
          mode: this.state.insert.jsonView ? 'json' : 'field-by-field',
          multiple: docs.length > 1,
        },
        this.connectionInfoRef.current
      );

      await this.dataService.insertMany(this.state.ns, docs);
      // track mode for analytics events
      const payload = {
        ns: this.state.ns,
        view: this.state.view,
        mode: this.state.insert.jsonView ? 'json' : 'default',
        multiple: true,
        docs,
      };
      void this.fieldStoreService.updateFieldsFromDocuments(
        this.state.ns,
        docs
      );
      // TODO(COMPASS-7815): Remove this event and use AppStoreService
      this.connectionScopedAppRegistry.emit('document-inserted', payload);

      this.state.insert = this.getInitialInsertState();
    } catch (error) {
      this.setState({
        insert: {
          doc: new Document({}),
          jsonDoc: this.state.insert.jsonDoc,
          jsonView: true,
          error: this.getWriteError(error as Error),
          csfleState: this.state.insert.csfleState,
          mode: ERROR,
          isOpen: true,
          isCommentNeeded: this.state.insert.isCommentNeeded,
        },
      });
    }

    // Since we are inserting a bunch of documents and we need to rerun all
    // the queries and counts for them, let's just refresh the whole set of
    // documents.
    void this.refreshDocuments();
  }

  /**
   * Insert the document given the document in current state.
   * Parse document from Json Insert View Modal or generate object from hadron document
   * view to insert.
   */
  async insertDocument() {
    this.track(
      'Document Inserted',
      {
        mode: this.state.insert.jsonView ? 'json' : 'field-by-field',
        multiple: false,
      },
      this.connectionInfoRef.current
    );

    let doc: BSONObject;

    try {
      if (this.state.insert.jsonView) {
        doc = HadronDocument.FromEJSON(
          this.state.insert.jsonDoc ?? ''
        ).generateObject();
      } else {
        doc = this.state.insert.doc!.generateObject();
      }
      await this.dataService.insertOne(this.state.ns, doc);

      const payload = {
        ns: this.state.ns,
        view: this.state.view,
        mode: this.state.insert.jsonView ? 'json' : 'default',
        multiple: false,
        docs: [doc],
      };
      void this.fieldStoreService.updateFieldsFromDocuments(this.state.ns, [
        doc,
      ]);
      // TODO(COMPASS-7815): Remove this event and use AppStoreService
      this.connectionScopedAppRegistry.emit('document-inserted', payload);

      this.state.insert = this.getInitialInsertState();
    } catch (error) {
      this.setState({
        insert: {
          doc: this.state.insert.doc,
          jsonDoc: this.state.insert.jsonDoc,
          jsonView: this.state.insert.jsonView,
          error: this.getWriteError(error as Error),
          csfleState: this.state.insert.csfleState,
          mode: ERROR,
          isOpen: true,
          isCommentNeeded: this.state.insert.isCommentNeeded,
        },
      });
      return;
    }

    void this.refreshDocuments();
  }

  /**
   * The user has drilled down into a new element.
   *
   * @param {HadronDocument} doc - The parent document.
   * @param {Element} element - The element being drilled into.
   * @param {Object} editParams - If we need to open a cell for editing, the coordinates.
   */
  drillDown(
    doc: Document,
    element: Element,
    editParams: TableState['editParams'] = null
  ) {
    this.setState({
      table: {
        path: this.state.table.path.concat([element.currentKey]),
        types: this.state.table.types.concat([element.currentType]),
        doc,
        editParams,
      },
    });
  }

  /**
   * The path of the table view has changed.
   *
   * @param {Array} path - A list of fieldnames and indexes.
   * @param {Array} types - A list of the types of each path segment.
   */
  pathChanged(path: (string | number)[], types: TableHeaderType[]) {
    this.setState({
      table: {
        doc: this.state.table.doc,
        editParams: this.state.table.editParams,
        path: path,
        types: types,
      },
    });
  }

  /**
   * The view has changed.
   *
   * @param {String} view - The new view.
   */
  viewChanged(view: CrudState['view']) {
    this.setState({ view: view });
  }

  /**
   * Detect if it is safe to perform the count query optimisation where we
   * specify the _id_ index as the hint.
   */
  isCountHintSafe(query: { filter?: unknown }) {
    const { isTimeSeries } = this.state;

    if (isTimeSeries) {
      // timeseries collections don't have the _id_ filter, so we can't use the hint speedup
      return false;
    }

    if (query.filter && Object.keys(query.filter).length) {
      // we can't safely use the hint speedup if there's a filter
      return false;
    }

    return true;
  }

  /**
   * Checks if the initial query was not modified.
   *
   * @param {Object} query - The query to check.
   *
   * @returns {Boolean}
   */
  isInitialQuery(query: Query = {}): boolean {
    return (
      isEmpty(query.filter) &&
      isEmpty(query.project) &&
      isEmpty(query.collation)
    );
  }

  collectionStatsFetched(model: Collection) {
    this.setState({
      collectionStats: extractCollectionStats(model),
    });
  }

  /**
   * This function is called when the collection filter changes.
   */
  async refreshDocuments(onApply = false) {
    if (this.dataService && !this.dataService.isConnected()) {
      this.logger.log.warn(
        mongoLogId(1_001_000_072),
        'Documents',
        'Trying to refresh documents but dataService is disconnected'
      );
      return;
    }

    const { ns, status, docsPerPage } = this.state;
    const query = this.queryBar.getLastAppliedQuery('crud');

    if (status === DOCUMENTS_STATUS_FETCHING) {
      return;
    }

    if (onApply) {
      const { isTimeSeries, isReadonly } = this.state;
      this.track(
        'Query Executed',
        {
          has_projection:
            !!query.project && Object.keys(query.project).length > 0,
          has_skip: (query.skip ?? 0) > 0,
          has_sort: !!query.sort && Object.keys(query.sort).length > 0,
          has_limit: (query.limit ?? 0) > 0,
          has_collation: !!query.collation,
          changed_maxtimems: query.maxTimeMS !== DEFAULT_INITIAL_MAX_TIME_MS,
          collection_type: isTimeSeries
            ? 'time-series'
            : isReadonly
            ? 'readonly'
            : 'collection',
          used_regex: objectContainsRegularExpression(query.filter ?? {}),
          mode: this.modeForTelemetry(),
        },
        this.connectionInfoRef.current
      );
    }

    // pass the signal so that the queries can close their own cursors and
    // reject their promises
    const abortController = new AbortController();
    const signal = abortController.signal;

    const fetchShardingKeysOptions = {
      maxTimeMS: capMaxTimeMSAtPreferenceLimit(
        this.preferences,
        query.maxTimeMS
      ),
      signal,
    };

    const countOptions: Parameters<typeof countDocuments>[4] = {
      skip: query.skip,
      maxTimeMS: capMaxTimeMSAtPreferenceLimit(
        this.preferences,
        (query.maxTimeMS ?? 0) > COUNT_MAX_TIME_MS_CAP
          ? COUNT_MAX_TIME_MS_CAP
          : query.maxTimeMS
      ),
      signal,
    };

    if (this.isCountHintSafe(query)) {
      countOptions.hint = '_id_';
    }

    let sort = query.sort;
    if (!sort && this.preferences.getPreferences().defaultSortOrder) {
      sort = validate(
        'sort',
        this.preferences.getPreferences().defaultSortOrder
      );
    }

    const findOptions = {
      sort,
      projection: query.project,
      skip: query.skip,
      limit: docsPerPage,
      collation: query.collation,
      maxTimeMS: capMaxTimeMSAtPreferenceLimit(
        this.preferences,
        query.maxTimeMS
      ),
      promoteValues: false,
      bsonRegExp: true,
    };

    // only set limit if it's > 0, read-only views cannot handle 0 limit.
    if (query.limit && query.limit > 0) {
      countOptions.limit = query.limit;
      findOptions.limit = Math.min(docsPerPage, query.limit);
    }

    this.logger.log.info(
      mongoLogId(1_001_000_073),
      'Documents',
      'Refreshing documents',
      {
        ns,
        withFilter: !isEmpty(query.filter),
        findOptions,
        countOptions,
      }
    );

    // Only check if index was used if query filter or sort is not empty
    if (!isEmpty(query.filter) || !isEmpty(query.sort)) {
      void this.dataService
        .explainFind(ns, query.filter ?? {}, findOptions as any, {
          explainVerbosity: 'queryPlanner',
          abortSignal: signal,
        })
        .then((rawExplainPlan) => {
          const explainPlan = new ExplainPlan(rawExplainPlan as Stage);
          this.setState({
            isCollectionScan: explainPlan.isCollectionScan,
          });
        })
        .catch(() => {
          // We are only fetching this to get information about index usage for
          // insight badge, if this fails for any reason, server, cancel, or
          // error parsing explan, we don't care and ignore it
        });
    } else {
      this.setState({ isCollectionScan: false });
    }

    // Don't wait for the count to finish. Set the result asynchronously.
    countDocuments(
      this.dataService,
      this.preferences,
      ns,
      query.filter ?? {},
      countOptions,
      (err: any) => {
        this.logger.log.warn(
          mongoLogId(1_001_000_288),
          'Documents',
          'Failed to count documents',
          err
        );
      }
    )
      .then((count) => this.setState({ count, loadingCount: false }))
      .catch((err) => {
        // countDocuments already swallows all db errors and returns null. The
        // only known error it can throw is AbortError. If
        // something new does appear we probably shouldn't swallow it.
        if (!this.dataService.isCancelError(err)) {
          throw err;
        }
        this.setState({ loadingCount: false });
      });

    const promises = [
      fetchShardingKeys(
        this.dataService,
        ns,
        fetchShardingKeysOptions,
        (err) => {
          this.logger.log.warn(
            mongoLogId(1_001_000_075),
            'Documents',
            'Failed to fetch sharding keys',
            err
          );
        }
      ),
      fetchDocuments(
        this.dataService,
        this.track,
        this.state.version,
        this.state.isDataLake,
        ns,
        query.filter ?? {},
        findOptions as any,
        {
          abortSignal: signal,
        }
      ),
    ] as const;

    // This is so that the UI can update to show that we're fetching
    this.setState({
      status: DOCUMENTS_STATUS_FETCHING,
      abortController,
      error: null,
      count: null, // we don't know the new count yet
      loadingCount: true,
    });

    // don't start showing the loading indicator and cancel button immediately
    const cancelDebounceLoad = this.debounceLoading();

    const stateChanges = {};

    try {
      const [shardKeys, docs] = await Promise.all(promises);

      Object.assign(stateChanges, {
        status: this.isInitialQuery(query)
          ? DOCUMENTS_STATUS_FETCHED_INITIAL
          : DOCUMENTS_STATUS_FETCHED_CUSTOM,
        error: null,
        docs: docs,
        page: 0,
        start: docs.length > 0 ? 1 : 0,
        end: docs.length,
        table: this.getInitialTableState(),
        shardKeys,
      });

      void this.fieldStoreService.updateFieldsFromDocuments(this.state.ns, [
        docs[0]?.generateObject(),
      ]);
    } catch (error) {
      this.logger.log.error(
        mongoLogId(1_001_000_074),
        'Documents',
        'Failed to refresh documents',
        error
      );
      Object.assign(stateChanges, {
        error,
        status: DOCUMENTS_STATUS_ERROR,
      });
    }

    // cancel the debouncing status if we load before the timer fires
    cancelDebounceLoad();

    Object.assign(stateChanges, {
      abortController: null,
      resultId: resultId(),
    });

    // Trigger all the accumulated changes once at the end
    this.setState(stateChanges);
  }

  cancelOperation() {
    // As we use same controller for all operations
    // (find, count and shardingKeys), aborting will stop all.
    this.state.abortController?.abort(new Error('This operation was aborted'));
    this.setState({ abortController: null });
  }

  debounceLoading() {
    this.setState({ debouncingLoad: true });

    const debouncePromise = new Promise((resolve) => {
      setTimeout(resolve, 200); // 200ms should feel about instant
    });

    let cancelDebounceLoad: () => void;
    const loadPromise = new Promise<void>((resolve) => {
      cancelDebounceLoad = resolve;
    });

    void Promise.race([debouncePromise, loadPromise]).then(() => {
      this.setState({ debouncingLoad: false });
    });

    return cancelDebounceLoad!;
  }

  hasProjection(query: BSONObject) {
    return !!(query.project && Object.keys(query.project).length > 0);
  }

  openCreateIndexModal() {
    this.localAppRegistry.emit('open-create-index-modal', {
      query: EJSON.serialize(this.queryBar.getLastAppliedQuery('crud')?.filter),
    });
  }

  openCreateSearchIndexModal() {
    this.localAppRegistry.emit('open-create-search-index-modal');
  }

  openBulkDeleteDialog() {
    this.track('Bulk Delete Opened', {}, this.connectionInfoRef.current);

    const PREVIEW_DOCS = 5;

    const previews = (this.state.docs?.slice(0, PREVIEW_DOCS) || []).map(
      (doc) => {
        // The idea is just to break the link with the docs in the list so that
        // expanding/collapsing docs in the modal doesn't modify the ones in the
        // list.
        return Document.FromEJSON(doc.toEJSON());
      }
    );

    this.setState({
      bulkDelete: {
        previews,
        status: 'open',
        affected: this.state.count ?? undefined,
      },
    });
  }

  bulkDeleteInProgress() {
    this.setState({
      bulkDelete: {
        ...this.state.bulkDelete,
        status: 'in-progress',
      },
    });

    openBulkDeleteProgressToast({
      affectedDocuments: this.state.bulkDelete.affected,
    });
  }

  bulkDeleteFailed(ex: Error) {
    openBulkDeleteFailureToast({
      affectedDocuments: this.state.bulkDelete.affected,
      error: ex,
    });

    this.logger.log.error(
      mongoLogId(1_001_000_268),
      'Bulk Delete Documents',
      `Delete operation failed: ${ex.message}`,
      ex
    );
  }

  bulkDeleteSuccess() {
    openBulkDeleteSuccessToast({
      affectedDocuments: this.state.bulkDelete.affected,
      onRefresh: () => void this.refreshDocuments(),
    });
  }

  closeBulkDeleteDialog() {
    this.setState({
      bulkDelete: {
        ...this.state.bulkDelete,
        status: 'closed',
      },
    });
  }

  async runBulkDelete() {
    this.track('Bulk Delete Executed', {}, this.connectionInfoRef.current);

    const { affected } = this.state.bulkDelete;
    this.closeBulkDeleteDialog();

    const confirmation = await showConfirmation({
      title: 'Are you absolutely sure?',
      buttonText: `Delete ${affected ? `${affected} ` : ''} document${
        affected !== 1 ? 's' : ''
      }`,
      description: `This action can not be undone. This will permanently delete ${
        affected ?? 'an unknown number of'
      } document${affected !== 1 ? 's' : ''}.`,
      variant: 'danger',
    });

    if (confirmation) {
      this.bulkDeleteInProgress();
      const { filter = {} } = this.queryBar.getLastAppliedQuery('crud');
      try {
        await this.dataService.deleteMany(this.state.ns, filter);
        this.bulkDeleteSuccess();
      } catch (ex) {
        this.bulkDeleteFailed(ex as Error);
      }
    }
  }

  openDeleteQueryExportToLanguageDialog(): void {
    const { filter = {} } = this.queryBar.getLastAppliedQuery('crud');
    this.localAppRegistry.emit(
      'open-query-export-to-language',
      {
        filter: toJSString(filter) || '{}',
      },
      'Delete Query'
    );
  }

  async saveUpdateQuery(name: string): Promise<void> {
    this.track(
      'Bulk Update Favorited',
      {
        isUpdatePreviewSupported: this.state.isUpdatePreviewSupported,
      },
      this.connectionInfoRef.current
    );

    const { filter } = this.queryBar.getLastAppliedQuery('crud');
    let update;
    try {
      update = parseShellBSON(this.state.bulkUpdate.updateText);
    } catch {
      // If this couldn't parse then the update button should have been
      // disabled. So if we get here it is a race condition and ignoring is
      // probably OK - the button will soon appear disabled to the user anyway.
      return;
    }

    await this.favoriteQueriesStorage?.saveQuery({
      _name: name,
      _ns: this.state.ns,
      filter,
      update,
    });
    openToast('saved-favorite-update-query', {
      title: '',
      variant: 'success',
      dismissible: true,
      timeout: 6_000,
      description: `${name} added to "My Queries".`,
    });
  }
}

export type CrudStore = Store & CrudStoreImpl & { gridStore: GridStore };
export type DocumentsPluginServices = {
  dataService: DataService;
  instance: MongoDBInstance;
  localAppRegistry: Pick<AppRegistry, 'on' | 'emit' | 'removeListener'>;
  globalAppRegistry: Pick<AppRegistry, 'on' | 'emit' | 'removeListener'>;
  preferences: PreferencesAccess;
  logger: Logger;
  track: TrackFunction;
  favoriteQueryStorageAccess?: FavoriteQueryStorageAccess;
  recentQueryStorageAccess?: RecentQueryStorageAccess;
  fieldStoreService: FieldStoreService;
  connectionInfoRef: ConnectionInfoRef;
  connectionScopedAppRegistry: ConnectionScopedAppRegistry<EmittedAppRegistryEvents>;
  queryBar: QueryBarService;
  collection: Collection;
};

export function activateDocumentsPlugin(
  options: CrudStoreOptions,
  {
    dataService,
    instance,
    localAppRegistry,
    globalAppRegistry,
    preferences,
    logger,
    track,
    favoriteQueryStorageAccess,
    recentQueryStorageAccess,
    fieldStoreService,
    connectionInfoRef,
    connectionScopedAppRegistry,
    queryBar,
    collection,
  }: DocumentsPluginServices,
  { on, cleanup }: ActivateHelpers
) {
  const actions = configureActions();
  const store = Reflux.createStore(
    new CrudStoreImpl(
      { ...options, actions },
      {
        instance,
        dataService,
        localAppRegistry,
        preferences,
        logger,
        track,
        connectionInfoRef,
        favoriteQueryStorage: favoriteQueryStorageAccess?.getStorage(),
        recentQueryStorage: recentQueryStorageAccess?.getStorage(),
        fieldStoreService,
        connectionScopedAppRegistry,
        queryBar,
        collection,
      }
    )
  ) as CrudStore;

  on(
    localAppRegistry,
    'favorites-open-bulk-update-favorite',
    (query: { update: BSONObject }) => {
      void store.refreshDocuments();
      void store.openBulkUpdateModal();
      void store.updateBulkUpdatePreview(
        toJSString(query.update) || INITIAL_BULK_UPDATE_TEXT
      );
    }
  );

  // these can change later
  on(instance, 'change:isWritable', () => {
    store.setState({ isWritable: instance.isWritable });
  });

  on(instance, 'change:description', () => {
    store.setState({ instanceDescription: instance.description });
  });

  on(globalAppRegistry, 'refresh-data', () => {
    void store.refreshDocuments();
  });

  on(
    globalAppRegistry,
    'import-finished',
    (
      { ns }: { ns: string },
      { connectionId }: { connectionId?: string } = {}
    ) => {
      const { id: currentConnectionId } = connectionInfoRef.current;
      if (currentConnectionId === connectionId && ns === store.state.ns) {
        void store.refreshDocuments();
      }
    }
  );

  on(collection, 'change:status', (model: Collection, status: string) => {
    if (status === 'ready') {
      store.collectionStatsFetched(model);
    }
  });

  if (!options.noRefreshOnConfigure) {
    queueMicrotask(() => {
      void store.refreshDocuments();
    });
  }

  if ((options.query as any)?.update) {
    // This will be set if the user clicked a bulk update query on the My Queries page
    const initialUpdate: BSONObject | undefined = (options.query as any)
      ?.update;
    const updateText = initialUpdate ? toJSString(initialUpdate) : undefined;

    queueMicrotask(() => {
      void store.openBulkUpdateModal(updateText);
    });
  }

  const gridStore = configureGridStore({ actions });
  store.gridStore = gridStore;

  return {
    store,
    actions,
    deactivate() {
      cleanup();
    },
  };
}

function resultId() {
  return Math.floor(Math.random() * 2 ** 53);
}

type ErrorOrResult =
  | [
      error: { message: string; code?: number; codeName?: string },
      result: undefined
    ]
  | [error: undefined | null, result: BSONObject];

export async function findAndModifyWithFLEFallback(
  ds: DataService,
  ns: string,
  query: BSONObject,
  object: { $set?: BSONObject; $unset?: BSONObject } | BSONObject | BSONArray,
  modificationType: 'update' | 'replace'
): Promise<ErrorOrResult> {
  const findOneAndModifyMethod =
    modificationType === 'update' ? 'findOneAndUpdate' : 'findOneAndReplace';
  let error: (Error & { codeName?: string; code?: any }) | undefined;

  try {
    return [
      undefined,
      await ds[findOneAndModifyMethod](ns, query, object, {
        returnDocument: 'after',
        promoteValues: false,
      }),
    ] as ErrorOrResult;
  } catch (e) {
    error = e as Error;
  }

  if (
    error.codeName === 'ShardKeyNotFound' ||
    +(error?.code ?? 0) === 63714_02 // 6371402 is "'findAndModify with encryption only supports new: false'"
  ) {
    const modifyOneMethod =
      modificationType === 'update' ? 'updateOne' : 'replaceOne';

    try {
      await ds[modifyOneMethod](ns, query, object);
    } catch (e) {
      // Return the modifyOneMethod error here
      // since we already know the original error from findOneAndModifyMethod
      // and want to know what went wrong with the fallback method,
      // e.g. return the `Found indexed encrypted fields but could not find __safeContent__` error.
      return [e, undefined] as ErrorOrResult;
    }

    try {
      const docs = await ds.find(
        ns,
        { _id: query._id as any },
        { promoteValues: false }
      );
      return [undefined, docs[0]] as ErrorOrResult;
    } catch {
      /* fallthrough */
    }
  }

  // Race condition -- most likely, somebody else
  // deleted the document between the findAndModify command
  // and the find command. Just return the original error.
  return [error, undefined] as ErrorOrResult;
}

// Copied from packages/compass-aggregations/src/modules/pipeline-builder/pipeline-parser/utils.ts
export function parseShellBSON(source: string): BSONObject | BSONObject[] {
  const parsed = _parseShellBSON(source, { mode: ParseMode.Loose });
  if (!parsed || typeof parsed !== 'object') {
    // XXX(COMPASS-5689): We've hit the condition in
    // https://github.com/mongodb-js/ejson-shell-parser/blob/c9c0145ababae52536ccd2244ac2ad01a4bbdef3/src/index.ts#L36
    throw new Error('The provided definition is invalid.');
  }
  return parsed as BSONObject | BSONObject[];
}
