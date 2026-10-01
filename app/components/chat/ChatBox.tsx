import React from 'react';
import { ClientOnly } from 'remix-utils/client-only';
import { classNames } from '~/utils/classNames';
import { PROVIDER_LIST } from '~/utils/constants';
import { ModelSelector } from '~/components/chat/ModelSelector';
import { APIKeyManager } from './APIKeyManager';
import { LOCAL_PROVIDERS } from '~/lib/stores/settings';
import FilePreview from './FilePreview';
import { ScreenshotStateManager } from './ScreenshotStateManager';
import { SendButton } from './SendButton.client';
import { IconButton } from '~/components/ui/IconButton';
import { toast } from 'react-toastify';
import { SpeechRecognitionButton } from '~/components/chat/SpeechRecognition';
import { SupabaseConnection } from './SupabaseConnection';
import { ExpoQrModal } from '~/components/workbench/ExpoQrModal';
import styles from './BaseChat.module.scss';
import type { ProviderInfo } from '~/types/model';
import { ColorSchemeDialog } from '~/components/ui/ColorSchemeDialog';
import type { DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/Inspector';
import { McpTools } from './MCPTools';
import { WebSearch } from './WebSearch.client';
import { Dropdown, DropdownItem, DropdownSeparator } from '~/components/ui/Dropdown';

interface ChatBoxProps {
  isModelSettingsCollapsed: boolean;
  setIsModelSettingsCollapsed: (collapsed: boolean) => void;
  provider: any;
  providerList: any[];
  modelList: any[];
  apiKeys: Record<string, string>;
  isModelLoading: string | undefined;
  onApiKeysChange: (providerName: string, apiKey: string) => void;
  uploadedFiles: File[];
  imageDataList: string[];
  textareaRef: React.RefObject<HTMLTextAreaElement> | undefined;
  input: string;
  handlePaste: (e: React.ClipboardEvent) => void;
  TEXTAREA_MIN_HEIGHT: number;
  TEXTAREA_MAX_HEIGHT: number;
  isStreaming: boolean;
  handleSendMessage: (event: React.UIEvent, messageInput?: string) => void;
  isListening: boolean;
  startListening: () => void;
  stopListening: () => void;
  chatStarted: boolean;
  exportChat?: () => void;
  qrModalOpen: boolean;
  setQrModalOpen: (open: boolean) => void;
  handleFileUpload: () => void;
  setProvider?: ((provider: ProviderInfo) => void) | undefined;
  model?: string | undefined;
  setModel?: ((model: string) => void) | undefined;
  setUploadedFiles?: ((files: File[]) => void) | undefined;
  setImageDataList?: ((dataList: string[]) => void) | undefined;
  handleInputChange?: ((event: React.ChangeEvent<HTMLTextAreaElement>) => void) | undefined;
  handleStop?: (() => void) | undefined;
  enhancingPrompt?: boolean | undefined;
  enhancePrompt?: (() => void) | undefined;
  onWebSearchResult?: (result: string) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  designScheme?: DesignScheme;
  setDesignScheme?: (scheme: DesignScheme) => void;
  selectedElement?: ElementInfo | null;
  setSelectedElement?: ((element: ElementInfo | null) => void) | undefined;
}

export const ChatBox: React.FC<ChatBoxProps> = (props) => {
  return (
    <div
      className={classNames(
        'relative bg-bolt-elements-background-depth-2 backdrop-blur p-2 rounded-lg border border-bolt-elements-borderColor relative w-full max-w-chat mx-auto z-prompt',

        /*
         * {
         *   'sticky bottom-2': chatStarted,
         * },
         */
      )}
    >
      <svg className={classNames(styles.PromptEffectContainer)}>
        <defs>
          <linearGradient
            id="line-gradient"
            x1="20%"
            y1="0%"
            x2="-14%"
            y2="10%"
            gradientUnits="userSpaceOnUse"
            gradientTransform="rotate(-45)"
          >
            <stop offset="0%" stopColor="#10B981" stopOpacity="0%"></stop>
            <stop offset="40%" stopColor="#10B981" stopOpacity="80%"></stop>
            <stop offset="50%" stopColor="#3B82C0" stopOpacity="80%"></stop>
            <stop offset="100%" stopColor="#3B82C0" stopOpacity="0%"></stop>
          </linearGradient>
          <linearGradient id="shine-gradient">
            <stop offset="0%" stopColor="white" stopOpacity="0%"></stop>
            <stop offset="40%" stopColor="#ffffff" stopOpacity="80%"></stop>
            <stop offset="50%" stopColor="#ffffff" stopOpacity="80%"></stop>
            <stop offset="100%" stopColor="white" stopOpacity="0%"></stop>
          </linearGradient>
        </defs>
        <rect className={classNames(styles.PromptEffectLine)} pathLength="100" strokeLinecap="round"></rect>
        <rect className={classNames(styles.PromptShine)} x="48" y="24" width="70" height="1"></rect>
      </svg>
      {/*
       * Hidden by projectsites brand override — re-enable via debug flag
       * if needed for support. The state machine + provider list still
       * compute so streaming/API/agent paths keep working unchanged.
       */}
      <div style={{ display: 'none' }} aria-hidden="true">
        <ClientOnly>
          {() => (
            <div className={props.isModelSettingsCollapsed ? 'hidden' : ''}>
              <ModelSelector
                key={props.provider?.name + ':' + (props.modelList?.length ?? 0)}
                model={props.model}
                setModel={props.setModel}
                modelList={props.modelList ?? []}
                provider={props.provider}
                setProvider={props.setProvider}
                providerList={props.providerList || (PROVIDER_LIST as ProviderInfo[])}
                apiKeys={props.apiKeys}
                modelLoading={props.isModelLoading}
              />
              {(props.providerList || []).length > 0 &&
                props.provider &&
                !LOCAL_PROVIDERS.includes(props.provider.name) && (
                  <APIKeyManager
                    provider={props.provider}
                    apiKey={props.apiKeys[props.provider.name] || ''}
                    setApiKey={(key) => {
                      props.onApiKeysChange(props.provider.name, key);
                    }}
                  />
                )}
            </div>
          )}
        </ClientOnly>
      </div>
      <FilePreview
        files={props.uploadedFiles}
        imageDataList={props.imageDataList}
        onRemove={(index) => {
          props.setUploadedFiles?.(props.uploadedFiles.filter((_, i) => i !== index));
          props.setImageDataList?.(props.imageDataList.filter((_, i) => i !== index));
        }}
      />
      <ClientOnly>
        {() => (
          <ScreenshotStateManager
            setUploadedFiles={props.setUploadedFiles}
            setImageDataList={props.setImageDataList}
            uploadedFiles={props.uploadedFiles}
            imageDataList={props.imageDataList}
          />
        )}
      </ClientOnly>
      {props.selectedElement && (
        <div className="flex mx-1.5 gap-2 items-center justify-between rounded-lg rounded-b-none border border-b-none border-bolt-elements-borderColor text-bolt-elements-textPrimary flex py-1 px-2.5 font-medium text-xs">
          <div className="flex gap-2 items-center lowercase">
            <code className="bg-accent-500 rounded-4px px-1.5 py-1 mr-0.5 text-white">
              {props?.selectedElement?.tagName}
            </code>
            selected for inspection
          </div>
          <button
            className="bg-transparent text-accent-500 pointer-auto"
            onClick={() => props.setSelectedElement?.(null)}
          >
            Clear
          </button>
        </div>
      )}
      <div
        className={classNames('relative shadow-xs border border-bolt-elements-borderColor backdrop-blur rounded-lg')}
      >
        <textarea
          ref={props.textareaRef}
          className={classNames(
            'w-full pl-3 pt-2.5 pr-16 outline-none resize-none text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary bg-transparent text-[13px] leading-relaxed',
            'transition-all duration-200',
            'hover:border-bolt-elements-focus focus:pt-3',
          )}
          onDragEnter={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '2px solid #1488fc';
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '2px solid #1488fc';
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '1px solid var(--bolt-elements-borderColor)';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '1px solid var(--bolt-elements-borderColor)';

            const files = Array.from(e.dataTransfer.files);
            files.forEach((file) => {
              if (file.type.startsWith('image/')) {
                const reader = new FileReader();

                reader.onload = (e) => {
                  const base64Image = e.target?.result as string;
                  props.setUploadedFiles?.([...props.uploadedFiles, file]);
                  props.setImageDataList?.([...props.imageDataList, base64Image]);
                };
                reader.readAsDataURL(file);
              }
            });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (event.shiftKey) {
                return;
              }

              event.preventDefault();

              if (props.isStreaming) {
                props.handleStop?.();
                return;
              }

              // ignore if using input method engine
              if (event.nativeEvent.isComposing) {
                return;
              }

              props.handleSendMessage?.(event);
            }
          }}
          value={props.input}
          onChange={(event) => {
            props.handleInputChange?.(event);
          }}
          onPaste={props.handlePaste}
          style={{
            minHeight: props.TEXTAREA_MIN_HEIGHT,
            maxHeight: props.TEXTAREA_MAX_HEIGHT,
          }}
          placeholder={props.chatMode === 'build' ? 'What are we shipping?' : 'What are we discussing?'}
          translate="no"
        />
        <ClientOnly>
          {() => (
            <SendButton
              show={props.input.length > 0 || props.isStreaming || props.uploadedFiles.length > 0}
              isStreaming={props.isStreaming}
              disabled={!props.providerList || props.providerList.length === 0}
              onClick={(event) => {
                if (props.isStreaming) {
                  props.handleStop?.();
                  return;
                }

                if (props.input.length > 0 || props.uploadedFiles.length > 0) {
                  props.handleSendMessage?.(event);
                }
              }}
            />
          )}
        </ClientOnly>
        {/*
         * Tightened bottom row — only attach / improve / mode-pill / overflow.
         * Send + stop live in <SendButton/> above. Speech, web-search, MCP, color
         * scheme, Supabase, model-chip moved into the ⋯ overflow to reduce
         * visual noise for the cinematic persona rollout (2026-05-24).
         */}
        <div className="flex justify-between items-center text-xs px-2.5 pb-2 pt-1">
          <div className="flex gap-1 items-center">
            <IconButton title="Attach file" className="transition-all" onClick={() => props.handleFileUpload()}>
              <div className="i-ph:paperclip text-xl"></div>
            </IconButton>
            <IconButton
              title="Improve with AI"
              disabled={props.input.length === 0 || props.enhancingPrompt}
              className={classNames('transition-all', props.enhancingPrompt ? 'opacity-100' : '')}
              onClick={() => {
                /*
                 * Only celebrate when the handler EXISTS — a missing enhancePrompt
                 * prop (no-op click) used to toast a lying 'Prompt enhanced!'.
                 * The enhancer itself replaces the input; the toast confirms it ran.
                 */
                if (!props.enhancePrompt) {
                  return;
                }

                props.enhancePrompt();
                toast.success('Prompt enhanced!');
              }}
            >
              {props.enhancingPrompt ? (
                <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-xl animate-spin"></div>
              ) : (
                <div className="i-bolt:stars text-xl"></div>
              )}
            </IconButton>
            {props.chatStarted && (
              <button
                type="button"
                title={
                  props.chatMode === 'discuss' ? 'Mode: discuss · click to build' : 'Mode: build · click to discuss'
                }
                className={classNames(
                  'font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-opacity leading-none',

                  /*
                   * Both modes render as the same polished accent pill (resolves to
                   * cyan in the dark theme / green in the light theme) — the LABEL is
                   * the mode indicator. The old `build` state was a fill-less ghost
                   * (tertiary 40%-opacity text + faint border) that read as a washed
                   * "all white" chip on the chat surface (Brian, 2026-08-21).
                   */
                  'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent border-bolt-elements-item-contentAccent hover:opacity-80',
                )}
                onClick={() => {
                  props.setChatMode?.(props.chatMode === 'discuss' ? 'build' : 'discuss');
                }}
              >
                {props.chatMode === 'discuss' ? 'discuss' : 'build'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Dropdown
              align="end"
              trigger={
                <IconButton title="More" className="transition-all">
                  <div className="i-ph:dots-three-outline-vertical text-xl" />
                </IconButton>
              }
            >
              <DropdownItem onSelect={() => props.exportChat?.()}>
                <div className="i-ph:download-simple text-base" />
                <span>Export chat</span>
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem onSelect={() => props.setQrModalOpen(true)}>
                <div className="i-ph:device-mobile text-base" />
                <span>Open on mobile (QR)</span>
              </DropdownItem>
              <DropdownSeparator />
              {/*
               * Power-user surfaces. Speech + web search + MCP + color scheme +
               * Supabase + design scheme stay reachable but no longer crowd
               * the primary input row. Each renders its own trigger inside.
               */}
              <div className="flex items-center gap-1 px-2 py-1">
                <WebSearch
                  onSearchResult={(result) => props.onWebSearchResult?.(result)}
                  disabled={props.isStreaming}
                />
                <McpTools />
                <ColorSchemeDialog designScheme={props.designScheme} setDesignScheme={props.setDesignScheme} />
                <SpeechRecognitionButton
                  isListening={props.isListening}
                  onStart={props.startListening}
                  onStop={props.stopListening}
                  disabled={props.isStreaming}
                />
                <SupabaseConnection />
              </div>
            </Dropdown>
          </div>
          <ExpoQrModal open={props.qrModalOpen} onClose={() => props.setQrModalOpen(false)} />
          {/*
           * Hidden by projectsites brand override — re-enable via debug flag
           * if needed for support. The model-settings state machine still
           * runs (collapsed=true by default in BaseChat); we only hide the
           * trigger chip + the inline ModelSelector panel above.
           */}
          <IconButton
            title="Model Settings"
            style={{ display: 'none' }}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => props.setIsModelSettingsCollapsed(!props.isModelSettingsCollapsed)}
            disabled={!props.providerList || props.providerList.length === 0}
          >
            <div
              className={classNames('i-ph:caret-right text-lg transition-transform', {
                'rotate-90': !props.isModelSettingsCollapsed,
              })}
            />
            <span className="text-xs">{props.model}</span>
          </IconButton>
        </div>
      </div>
    </div>
  );
};
