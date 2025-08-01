import React, { useCallback, useMemo, useRef } from 'react';
import { connect } from 'react-redux';
import type { MongoServerError } from 'mongodb';
import {
  CodemirrorMultilineEditor,
  createStageAutocompleter,
} from '@mongodb-js/compass-editor';
import type { Annotation, EditorRef } from '@mongodb-js/compass-editor';
import {
  css,
  cx,
  spacing,
  palette,
  Banner,
  useDarkMode,
  useRequiredURLSearchParams,
} from '@mongodb-js/compass-components';
import {
  changeStageValue,
  pipelineFromStore,
} from '../../modules/pipeline-builder/stage-editor';
import type { StoreStage } from '../../modules/pipeline-builder/stage-editor';
import { mapPipelineModeToEditorViewType } from '../../modules/pipeline-builder/builder-helpers';
import type { RootState } from '../../modules';
import type { PipelineParserError } from '../../modules/pipeline-builder/pipeline-parser/utils';
import { useAutocompleteFields } from '@mongodb-js/compass-field-store';
import { useTelemetry } from '@mongodb-js/compass-telemetry/provider';
import { useConnectionInfoRef } from '@mongodb-js/compass-connections/provider';

const editorContainerStyles = css({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  alignItems: 'stretch',
  overflow: 'hidden',
  height: '100%',
});

const editorContainerStylesDark = css({});

const editorContainerStylesLight = css({
  background: palette.gray.light3,
});

const codeEditorContainerStyles = css({
  flex: 1,
  flexShrink: 0,
  margin: 0,
  width: '100%',
  minHeight: '230px',
});

// We use custom color here so need to disable default one that we use
// everywhere else
const codeEditorStyles = css({
  '& .cm-editor': {
    background: 'transparent !important',
  },
});

const bannerStyles = css({
  flex: 'none',
  marginTop: spacing[200],
  marginLeft: spacing[200],
  marginRight: spacing[200],
  textAlign: 'left',
});

type StageEditorProps = {
  index: number;
  namespace: string;
  stageOperator: string | null;
  stageValue: string | null;
  serverVersion: string;
  syntaxError: PipelineParserError | null;
  serverError: MongoServerError | null;
  num_stages: number;
  editor_view_type: 'text' | 'stage' | 'focus';
  className?: string;
  onChange: (index: number, value: string) => void;
  editorRef?: React.Ref<EditorRef>;
};

export const StageEditor = ({
  namespace,
  stageValue,
  stageOperator,
  index,
  onChange,
  serverError,
  syntaxError,
  className,
  serverVersion,
  num_stages,
  editor_view_type,
  editorRef,
}: StageEditorProps) => {
  const track = useTelemetry();
  const connectionInfoRef = useConnectionInfoRef();
  const darkMode = useDarkMode();
  const editorInitialValueRef = useRef<string | null>(stageValue);
  const editorCurrentValueRef = useRef<string | null>(stageValue);
  editorCurrentValueRef.current = stageValue;

  const fields = useAutocompleteFields(namespace);

  const { utmSource, utmMedium } = useRequiredURLSearchParams();

  const completer = useMemo(() => {
    return createStageAutocompleter({
      serverVersion,
      stageOperator: stageOperator ?? undefined,
      fields,
      utmSource,
      utmMedium,
    });
  }, [fields, serverVersion, stageOperator, utmSource, utmMedium]);

  const annotations = useMemo<Annotation[]>(() => {
    if (syntaxError?.loc?.index) {
      return [
        {
          message: syntaxError.message,
          severity: 'error',
          from: syntaxError.loc.index,
          to: syntaxError.loc.index,
        },
      ];
    }

    return [];
  }, [syntaxError]);

  const onBlurEditor = useCallback(() => {
    if (
      !!editorCurrentValueRef.current &&
      editorCurrentValueRef.current !== editorInitialValueRef.current
    ) {
      track(
        'Aggregation Edited',
        {
          num_stages: num_stages,
          stage_index: index + 1,
          stage_action: 'stage_content_changed',
          stage_name: stageOperator,
          editor_view_type: editor_view_type,
        },
        connectionInfoRef.current
      );
      editorInitialValueRef.current = editorCurrentValueRef.current;
    }
  }, [
    track,
    num_stages,
    index,
    stageOperator,
    editor_view_type,
    connectionInfoRef,
  ]);

  return (
    <div
      data-testid="stage-editor"
      className={cx(
        editorContainerStyles,
        darkMode ? editorContainerStylesDark : editorContainerStylesLight,
        className
      )}
    >
      <div className={codeEditorContainerStyles}>
        <CodemirrorMultilineEditor
          ref={editorRef}
          text={stageValue ?? ''}
          onChangeText={(value: string) => {
            onChange(index, value);
          }}
          className={codeEditorStyles}
          id={`aggregations-stage-editor-${index}`}
          completer={completer}
          annotations={annotations}
          onBlur={onBlurEditor}
        />
      </div>
      {syntaxError && (
        <Banner
          variant="warning"
          data-testid="stage-editor-syntax-error"
          title={syntaxError.message}
          className={bannerStyles}
        >
          {!stageOperator
            ? 'Stage operator is required'
            : !stageValue
            ? 'Stage value can not be empty'
            : syntaxError.message}
        </Banner>
      )}
      {serverError && (
        <Banner
          variant="danger"
          data-testid="stage-editor-error-message"
          title={serverError.message}
          className={bannerStyles}
        >
          {serverError.message}
        </Banner>
      )}
    </div>
  );
};

export default connect(
  (state: RootState, ownProps: { index: number }) => {
    const stages = state.pipelineBuilder.stageEditor.stages;
    const stage = stages[ownProps.index] as StoreStage;
    const num_stages = pipelineFromStore(stages).length;
    return {
      namespace: state.namespace,
      stageValue: stage.value,
      stageOperator: stage.stageOperator,
      syntaxError: !stage.empty ? stage.syntaxError ?? null : null,
      serverError: !stage.empty ? stage.serverError ?? null : null,
      serverVersion: state.serverVersion,
      num_stages,
      editor_view_type: mapPipelineModeToEditorViewType(state),
    };
  },
  { onChange: changeStageValue }
)(StageEditor);
