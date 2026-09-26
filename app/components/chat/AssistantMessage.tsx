import { memo, Fragment } from 'react';
import { Markdown } from './Markdown';
import type { JSONValue } from 'ai';
import Popover from '~/components/ui/Popover';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import WithTooltip from '~/components/ui/Tooltip';
import type { Message } from 'ai';
import type { ProviderInfo } from '~/types/model';
import type {
  TextUIPart,
  ReasoningUIPart,
  ToolInvocationUIPart,
  SourceUIPart,
  FileUIPart,
  StepStartUIPart,
} from '@ai-sdk/ui-utils';
import { ToolInvocations } from './ToolInvocations';
import type { ToolCallAnnotation } from '~/types/context';
import { FileDiffBadges, summarizeTouchedFiles } from './FileDiffBadges';
import { hasSnapshotFor, restoreSnapshot } from '~/lib/chat/ai-undo';
import { toast } from 'react-toastify';
import { parseSiteImport } from './site-import-status';
import { SiteImportStatus } from './SiteImportStatus';

interface AssistantMessageProps {
  content: string;
  annotations?: JSONValue[];
  messageId?: string;
  onRewind?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  append?: (message: Message) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  isStreaming?: boolean;
  isLast?: boolean;
  parts:
    | (TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | FileUIPart | StepStartUIPart)[]
    | undefined;
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: any }) => void;
}

function openArtifactInWorkbench(filePath: string) {
  filePath = normalizedFilePath(filePath);

  if (workbenchStore.currentView.get() !== 'code') {
    workbenchStore.currentView.set('code');
  }

  workbenchStore.setSelectedFile(`${WORK_DIR}/${filePath}`);
}

function normalizedFilePath(path: string) {
  let normalizedPath = path;

  if (normalizedPath.startsWith(WORK_DIR)) {
    normalizedPath = path.replace(WORK_DIR, '');
  }

  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.slice(1);
  }

  return normalizedPath;
}

export const AssistantMessage = memo(
  ({
    content,
    annotations,
    messageId,
    onRewind,
    onFork,
    append,
    chatMode,
    setChatMode,
    model,
    provider,
    parts,
    addToolResult,
    isStreaming,
    isLast,
  }: AssistantMessageProps) => {
    /*
     * The initial imported-site greeting ("I've built … The project files are: <list>"
     * + its per-file "Create <path>" artifact) is replaced by a single live status card
     * ("Loading N files…" → "Loaded N files"). Files still load — the message parser, not
     * this render, drives file creation — so hiding the verbose UI has no side effects.
     */
    const siteImport = parseSiteImport(content);

    if (siteImport.isSiteImport) {
      return (
        <div className="overflow-hidden w-full ps-msg ps-msg--ai" data-role="ai">
          <SiteImportStatus expectedFileCount={siteImport.expectedFileCount} />
        </div>
      );
    }

    const touched = summarizeTouchedFiles(content);
    const looksTruncated =
      !isStreaming &&
      isLast &&
      content.length > 80 &&
      !/[.!?`}\])]\s*$/.test(content.slice(-8)) &&
      !content.trimEnd().endsWith('</boltArtifact>');

    const handleUndo = async () => {
      if (!messageId) {
        return;
      }

      const count = await restoreSnapshot(messageId);

      if (count > 0) {
        toast.success(`Reverted ${count} file${count === 1 ? '' : 's'} to pre-AI state`);
      } else {
        toast.info('No snapshot available for this message');
      }
    };

    const handleContinue = () => {
      append?.({
        id: `continue-${Date.now()}`,
        role: 'user',
        content:
          'Continue from where you left off. Pick up exactly where the previous response stopped — do not repeat content.',
      } as Message);
    };

    const filteredAnnotations = (annotations?.filter(
      (annotation: JSONValue) =>
        annotation && typeof annotation === 'object' && Object.keys(annotation).includes('type'),
    ) || []) as { type: string; value: any } & { [key: string]: any }[];

    let chatSummary: string | undefined = undefined;

    if (filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')) {
      chatSummary = filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')?.summary;
    }

    let codeContext: string[] | undefined = undefined;

    if (filteredAnnotations.find((annotation) => annotation.type === 'codeContext')) {
      codeContext = filteredAnnotations.find((annotation) => annotation.type === 'codeContext')?.files;
    }

    const usage: {
      completionTokens: number;
      promptTokens: number;
      totalTokens: number;
    } = filteredAnnotations.find((annotation) => annotation.type === 'usage')?.value;

    const toolInvocations = parts?.filter((part) => part.type === 'tool-invocation');
    const toolCallAnnotations = filteredAnnotations.filter(
      (annotation) => annotation.type === 'toolCall',
    ) as ToolCallAnnotation[];

    return (
      <div className="overflow-hidden w-full ps-msg ps-msg--ai" data-role="ai">
        <>
          <div className=" flex gap-2 items-center text-sm text-bolt-elements-textSecondary mb-2">
            {(codeContext || chatSummary) && (
              <Popover side="right" align="start" trigger={<div className="i-ph:info" />}>
                {chatSummary && (
                  <div className="max-w-chat">
                    <div className="summary max-h-96 flex flex-col">
                      <h2 className="border border-bolt-elements-borderColor rounded-md p4">Summary</h2>
                      <div style={{ zoom: 0.7 }} className="overflow-y-auto m4">
                        <Markdown>{chatSummary}</Markdown>
                      </div>
                    </div>
                    {codeContext && (
                      <div className="code-context flex flex-col p4 border border-bolt-elements-borderColor rounded-md">
                        <h2>Context</h2>
                        <div className="flex gap-4 mt-4 bolt" style={{ zoom: 0.6 }}>
                          {codeContext.map((x) => {
                            const normalized = normalizedFilePath(x);
                            return (
                              <Fragment key={normalized}>
                                <code
                                  className="bg-bolt-elements-artifacts-inlineCode-background text-bolt-elements-artifacts-inlineCode-text px-1.5 py-1 rounded-md text-bolt-elements-item-contentAccent hover:underline cursor-pointer"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    openArtifactInWorkbench(normalized);
                                  }}
                                >
                                  {normalized}
                                </code>
                              </Fragment>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="context"></div>
              </Popover>
            )}
            <div className="flex w-full items-center justify-between">
              {usage && (
                <div>
                  Tokens: {usage.totalTokens} (prompt: {usage.promptTokens}, completion: {usage.completionTokens})
                </div>
              )}
              {(onRewind || onFork) && messageId && (
                <div className="flex gap-2 flex-col lg:flex-row ml-auto">
                  {messageId && hasSnapshotFor(messageId) && (
                    <WithTooltip tooltip="Undo last AI message (restore files)">
                      <button
                        onClick={handleUndo}
                        data-testid="ai-undo-button"
                        className="i-ph:arrow-counter-clockwise text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {onRewind && (
                    <WithTooltip tooltip="Revert to this message">
                      <button
                        onClick={() => onRewind(messageId)}
                        key="i-ph:arrow-u-up-left"
                        className="i-ph:arrow-u-up-left text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {/* "Fork chat from this message" button removed per product decision.
                      The fork handler stays wired (onFork) — only the control is gone. */}
                </div>
              )}
            </div>
          </div>
        </>
        <FileDiffBadges content={content} />
        <Markdown append={append} chatMode={chatMode} setChatMode={setChatMode} model={model} provider={provider} html>
          {content}
        </Markdown>
        {touched.count > 1 && (
          <div
            data-testid="other-files-touched"
            className="mt-2 text-[11px] text-bolt-elements-textTertiary flex items-center gap-1"
          >
            <span className="i-ph:files text-sm" />
            Other files touched: {touched.count}
            <span className="font-mono ml-1 truncate">
              ({touched.paths.slice(0, 3).join(', ')}
              {touched.paths.length > 3 ? `, +${touched.paths.length - 3} more` : ''})
            </span>
          </div>
        )}
        {looksTruncated && append && (
          <button
            type="button"
            onClick={handleContinue}
            data-testid="ai-continue-button"
            className="mt-2 text-xs px-3 py-1.5 rounded-md bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent border border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-item-backgroundActive transition-colors inline-flex items-center gap-1"
          >
            <span className="i-ph:arrow-right" />
            Continue from here
          </button>
        )}
        {toolInvocations && toolInvocations.length > 0 && (
          <ToolInvocations
            toolInvocations={toolInvocations}
            toolCallAnnotations={toolCallAnnotations}
            addToolResult={addToolResult}
          />
        )}
      </div>
    );
  },
);
