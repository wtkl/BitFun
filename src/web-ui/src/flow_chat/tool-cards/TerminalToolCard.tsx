/**
 * Terminal tool card component
 * Displays command execution output (streaming progress + final result)
 * 
 * Status-driven design:
 * - All button display logic depends entirely on backend status, no local state redundancy
 * - Confirm button: only shown when status === 'pending_confirmation'
 * - Interrupt button: only shown when status === 'running'
 * 
 * - Uses _progressMessage to display real-time progress (from ToolExecutionProgress event)
 * - Uses output field to display completed results (no longer distinguishes stdout/stderr)
 * - Clicking "Open Terminal in right panel" button opens full Terminal tab
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { Terminal, Play, X, ExternalLink, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { createTerminalTab } from '@/shared/utils/tabUtils';
import { BaseToolCard, ToolCardHeader } from './BaseToolCard';
import { CubeLoading, IconButton, Input } from '../../component-library';
import { TerminalOutputRenderer } from '@/tools/terminal/components';
import { Tooltip } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import './TerminalToolCard.scss';

const log = createLogger('TerminalToolCard');

interface TerminalToolCardProps extends ToolCardProps {
  terminalSessionId?: string;
}

const TERMINAL_STATES = ['completed', 'cancelled', 'error', 'rejected'] as const;

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATES.includes(status as typeof TERMINAL_STATES[number]);
}

interface ExpandedStateCache {
  expanded: boolean;
  isManual: boolean;
}
const expandedStateCache = new Map<string, ExpandedStateCache>();

function getCachedExpandedState(toolId: string | undefined): ExpandedStateCache | undefined {
  if (!toolId) return undefined;
  return expandedStateCache.get(toolId);
}

function setCachedExpandedState(toolId: string | undefined, expanded: boolean, isManual: boolean): void {
  if (!toolId) return;
  expandedStateCache.set(toolId, { expanded, isManual });
}

function getInitialExpandedState(toolId: string | undefined, status: string): boolean {
  const cached = getCachedExpandedState(toolId);
  if (cached !== undefined) {
    return cached.expanded;
  }
  if (isTerminalStatus(status) || status === 'pending_confirmation') {
    return false;
  }
  return true;
}

export const TerminalToolCard: React.FC<TerminalToolCardProps> = ({
  toolItem,
  onConfirm,
  onReject,
  onExpand,
  terminalSessionId: propTerminalSessionId,
  sessionId
}) => {
  const { t } = useTranslation('flow-chat');
  const toolCall = toolItem.toolCall;
  const toolResult = toolItem.toolResult;
  const command = toolCall?.input?.command;
  
  const status = toolItem.status || 'pending';
  const progressMessage = (toolItem as any)._progressMessage || '';
  
  const terminalSessionId = useMemo(() => {
    if (toolResult?.result?.terminal_session_id) {
      const id = toolResult.result.terminal_session_id;
      if (typeof id === 'string' && !id.startsWith('FlowChat-')) {
        return id;
      }
    }
    
    if (propTerminalSessionId && !propTerminalSessionId.startsWith('FlowChat-')) {
      return propTerminalSessionId;
    }
    
    if (sessionId && !sessionId.startsWith('FlowChat-')) {
      return sessionId;
    }
    
    return undefined;
  }, [toolResult, propTerminalSessionId, sessionId]);

  const showConfirmButtons = status === 'pending_confirmation';
  const showInterruptButton = status === 'running';
  const canEditCommand = showConfirmButtons;
  
  const [userAction, setUserAction] = useState<'none' | 'rejected' | 'interrupted'>('none');
  const toolId = toolCall?.id;
  const isTerminalState = isTerminalStatus(status);
  
  const [isExpanded, setIsExpanded] = useState(() => getInitialExpandedState(toolId, status));
  const [isExecuting, setIsExecuting] = useState(false);
  const [isEditingCommand, setIsEditingCommand] = useState(false);
  const [editedCommand, setEditedCommand] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const hasInitializedExpand = useRef(false);
  const previousStatusRef = useRef<string>(status);
  
  const [accumulatedOutput, setAccumulatedOutput] = useState('');

  useEffect(() => {
    if (terminalSessionId && !hasInitializedExpand.current) {
      if (isTerminalState) {
        hasInitializedExpand.current = true;
        return;
      }
      
      const cached = getCachedExpandedState(toolId);
      if (cached === undefined || !cached.isManual) {
        setIsExpanded(true);
        setCachedExpandedState(toolId, true, false);
      }
      hasInitializedExpand.current = true;
    }
  }, [terminalSessionId, toolId, isTerminalState]);

  useEffect(() => {
    const prevStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    
    const cached = getCachedExpandedState(toolId);
    if (cached?.isManual) {
      return;
    }
    
    if (status === 'running' && prevStatus !== 'running') {
      setIsExpanded(true);
      setCachedExpandedState(toolId, true, false);
    }
    
    if (!isTerminalStatus(prevStatus) && isTerminalStatus(status)) {
      setIsExpanded(false);
      setCachedExpandedState(toolId, false, false);
    }
  }, [status, toolId]);
  
  useEffect(() => {
    if (progressMessage && (status === 'running' || status === 'streaming')) {
      setAccumulatedOutput(prev => prev + progressMessage);
    }
  }, [progressMessage, status]);
  
  useEffect(() => {
    if (status === 'completed' || status === 'error' || status === 'cancelled') {
      setAccumulatedOutput('');
    }
  }, [status]);

  const handleStartEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditedCommand(command || '');
    setIsEditingCommand(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [command]);

  const handleSaveEdit = useCallback(() => {
    setIsEditingCommand(false);
    if (toolCall?.input) {
      toolCall.input.command = editedCommand;
    }
  }, [editedCommand, toolCall]);

  const handleCancelEdit = useCallback(() => {
    setIsEditingCommand(false);
    setEditedCommand(command || '');
  }, [command]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  }, [handleSaveEdit, handleCancelEdit]);

  const handleExecute = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const commandToExecute = isEditingCommand ? editedCommand : command;
    
    if (!commandToExecute || commandToExecute.trim() === '') {
      return;
    }

    setIsExecuting(true);
    setIsExpanded(true);
    setAccumulatedOutput('');

    try {
      const inputToConfirm = { 
        ...(toolCall?.input || {}), 
        command: commandToExecute 
      };
      
      onConfirm?.(inputToConfirm);
    } catch (error) {
      log.error('Command confirmation failed', { command: commandToExecute, error });
    } finally {
      setIsExecuting(false);
    }
  }, [command, editedCommand, isEditingCommand, toolCall?.input, onConfirm]);

  const handleReject = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setUserAction('rejected');
    onReject?.();
  }, [onReject]);

  const handleInterrupt = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    const toolUseId = toolCall?.id;
    if (!toolUseId) {
      return;
    }

    setUserAction('interrupted');
    
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cancel_tool', {
        request: {
          toolUseId: toolUseId,
          reason: 'User cancelled'
        }
      });
    } catch (error) {
      log.error('Failed to send cancel signal', { toolUseId, error });
    }
  }, [toolCall?.id]);

  const toggleExpand = useCallback(() => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    setCachedExpandedState(toolId, newExpanded, true);
    onExpand?.();
  }, [isExpanded, toolId, onExpand]);
  
  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggleExpand();
  }, [toggleExpand]);

  const handleOpenInPanel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!terminalSessionId) {
      return;
    }

    const terminalName = `Chat-${terminalSessionId.slice(0, 8)}`;

    window.dispatchEvent(new CustomEvent('expand-right-panel'));

    setTimeout(() => {
      createTerminalTab(terminalSessionId, terminalName);
    }, 250);
  }, [terminalSessionId]);

  const output = toolResult?.result?.output || '';
  const exitCode = toolResult?.result?.exit_code ?? 0;
  const workingDir = toolResult?.result?.working_directory || '';
  const executionTimeMs = toolResult?.result?.execution_time_ms;
  const wasInterrupted = toolResult?.result?.interrupted || false;

  const isLoading = status === 'preparing' || status === 'streaming' || status === 'running';
  const isFailed = status === 'error';

  const renderToolIcon = () => {
    return <Terminal size={16} />;
  };

  const renderStatusIcon = () => {
    if (isLoading) {
      return <CubeLoading size="small" />;
    }
    return null;
  };

  const renderCommandContent = () => {
    if (isEditingCommand && canEditCommand) {
      return (
        <input
          ref={inputRef}
          type="text"
          className="terminal-command-input"
          value={editedCommand}
          onChange={(e) => setEditedCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSaveEdit}
          onClick={(e) => e.stopPropagation()}
          placeholder={t('toolCards.terminal.inputPlaceholder')}
        />
      );
    }
    
    return (
      <code 
        className={`terminal-command ${canEditCommand ? 'editable' : ''}`}
        onClick={canEditCommand ? handleStartEdit : undefined}
        title={canEditCommand ? t('toolCards.terminal.clickToEditCommand') : undefined}
      >
        {command || (canEditCommand ? <span className="command-empty">{t('toolCards.terminal.commandEmpty')}</span> : <span className="command-empty">{t('toolCards.terminal.noCommand')}</span>)}
      </code>
    );
  };

  const renderStatusText = () => {
    if (!isTerminalState) {
      return null;
    }
    
    if (userAction === 'rejected') {
      return <span className="terminal-status-text status-rejected">{t('toolCards.terminal.rejected')}</span>;
    }
    if (userAction === 'interrupted' || wasInterrupted) {
      return <span className="terminal-status-text status-cancelled">{t('toolCards.terminal.cancelled')}</span>;
    }
    
    switch (status) {
      case 'completed':
        return <span className="terminal-status-text status-completed">{t('toolCards.terminal.completed')}</span>;
      case 'cancelled':
        return <span className="terminal-status-text status-cancelled">{t('toolCards.terminal.cancelled')}</span>;
      case 'error':
        return <span className="terminal-status-text status-error">{t('toolCards.terminal.failed')}</span>;
      default:
        if ((status as string) === 'rejected') {
          return <span className="terminal-status-text status-rejected">{t('toolCards.terminal.rejected')}</span>;
        }
        return null;
    }
  };

  const renderHeader = () => {
    return (
      <ToolCardHeader
        icon={renderToolIcon()}
        iconClassName="terminal-icon"
        action={t('toolCards.terminal.executeCommand')}
        content={renderCommandContent()}
        extra={
          <>
            {renderStatusText()}

            {showConfirmButtons && (
              <div className="terminal-confirm-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton 
                  className="terminal-action-btn execute-btn"
                  variant="success"
                  size="xs"
                  onClick={handleExecute}
                  disabled={isExecuting || (!isEditingCommand && !command) || (isEditingCommand && !editedCommand)}
                  tooltip={
                    (!isEditingCommand && !command) || (isEditingCommand && !editedCommand)
                      ? t('toolCards.terminal.commandEmptyWarning')
                      : t('toolCards.terminal.executeCommandTitle')
                  }
                >
                  <Play size={12} fill="currentColor" />
                </IconButton>
                <IconButton 
                  className="terminal-action-btn cancel-btn"
                  variant="danger"
                  size="xs"
                  onClick={handleReject}
                  disabled={isExecuting}
                  tooltip={t('toolCards.terminal.cancel')}
                >
                  <X size={14} />
                </IconButton>
              </div>
            )}

            {showInterruptButton && (
              <IconButton 
                className="terminal-action-btn interrupt-btn"
                variant="warning"
                size="xs"
                onClick={handleInterrupt}
                tooltip={t('toolCards.terminal.interrupt')}
              >
                <Square size={12} fill="currentColor" />
              </IconButton>
            )}

            {terminalSessionId && (
              <IconButton 
                className="terminal-action-btn external-btn"
                variant="ghost"
                size="xs"
                onClick={handleOpenInPanel}
                tooltip={t('toolCards.terminal.openInPanel')}
              >
                <ExternalLink size={12} />
              </IconButton>
            )}

            <IconButton 
              className="terminal-action-btn toggle-btn"
              variant="ghost"
              size="xs"
              onClick={handleToggleExpand}
              tooltip={isExpanded ? t('toolCards.terminal.collapseOutput') : t('toolCards.terminal.expandOutput')}
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </IconButton>
          </>
        }
        statusIcon={renderStatusIcon()}
      />
    );
  };

  const renderExpandedContent = () => {
    return (
      <>
        {(status === 'running' || status === 'streaming') && accumulatedOutput && (
          <div className="terminal-execution-output">
            <TerminalOutputRenderer 
              content={accumulatedOutput}
              className="terminal-xterm-output"
            />
          </div>
        )}
        
        {(status === 'running' || status === 'streaming') && !accumulatedOutput && (
          <div className="terminal-execution-output terminal-waiting">
            <span className="waiting-text">{t('toolCards.terminal.executingCommand')}</span>
          </div>
        )}

        {status === 'completed' && (
          <div className="terminal-result-container">
            <div className="terminal-result-header">
              {workingDir && (
                <>
                  <span className="terminal-result-label">{t('toolCards.terminal.workingDirectory')}</span>
                  <span className="terminal-result-value">{workingDir}</span>
                </>
              )}
              <span className={`terminal-exit-code ${exitCode === 0 ? 'success' : 'error'}`}>
                {t('toolCards.terminal.exitCode', { code: exitCode })}
              </span>
              {executionTimeMs && (
                <span className="terminal-execution-time">
                  {executionTimeMs}ms
                </span>
              )}
            </div>
            
            {output && (
              <div className="terminal-result-output">
                <TerminalOutputRenderer 
                  content={output}
                  className="terminal-xterm-output"
                />
              </div>
            )}
          </div>
        )}
        
        {status === 'cancelled' && accumulatedOutput && (
          <div className="terminal-result-container cancelled">
            <div className="terminal-result-header">
              <span className="terminal-cancelled-text">{t('toolCards.terminal.commandInterrupted')}</span>
            </div>
            <div className="terminal-result-output">
              <TerminalOutputRenderer 
                content={accumulatedOutput}
                className="terminal-xterm-output"
              />
            </div>
          </div>
        )}
      </>
    );
  };

  const renderErrorContent = () => (
    <div className="error-content">
      <div className="error-message">
        {toolResult?.error || t('toolCards.terminal.executionFailed')}
      </div>
    </div>
  );

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.terminal-action-btn, .terminal-command-input, .terminal-confirm-actions')) {
      return;
    }
    toggleExpand();
  }, [toggleExpand]);

  return (
    <BaseToolCard
      status={status}
      isExpanded={isExpanded}
      onClick={handleCardClick}
      className="terminal-tool-card"
      header={renderHeader()}
      expandedContent={isExpanded ? renderExpandedContent() : null}
      errorContent={isFailed ? renderErrorContent() : null}
      isFailed={isFailed}
      requiresConfirmation={showConfirmButtons}
    />
  );
};

export default TerminalToolCard;

