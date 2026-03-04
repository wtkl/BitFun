/**
 * Default tool card component
 * Used for tool types without specific customization
 */

import React from 'react';
import { Loader2, XCircle, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';

export const DefaultToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  config,
  onConfirm,
  onReject,
  onExpand
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, status, requiresConfirmation, userConfirmed } = toolItem;

  const handleConfirm = () => {
    onConfirm?.(toolCall?.input);
  };

  const handleReject = () => {
    onReject?.();
  };

  const getStatusIcon = () => {
    switch (status) {
      case 'running':
      case 'streaming':
        return <Loader2 className="animate-spin" size={12} />;
      case 'completed':
        return null;
      case 'cancelled':
        return <XCircle size={12} />;
      case 'error':
        return <XCircle size={12} />;
      default:
        return <Clock size={12} />;
    }
  };

  const getStatusText = () => {
    if (requiresConfirmation && !userConfirmed) {
      return t('toolCards.default.waitingConfirm');
    }
    
    const progressMessage = (toolItem as any)._progressMessage;
    if (progressMessage && (status === 'running' || status === 'streaming')) {
      return progressMessage;
    }
    
    switch (status) {
      case 'streaming':
      case 'running':
        return t('toolCards.default.executing');
      case 'completed':
        return t('toolCards.default.completed');
      case 'cancelled':
        return t('toolCards.default.cancelled');
      case 'error':
        return t('toolCards.default.failed');
      default:
        return t('toolCards.default.preparing');
    }
  };

  const showConfirmationHighlight = requiresConfirmation && !userConfirmed && 
    status !== 'completed' && 
    status !== 'cancelled' && 
    status !== 'error';

  return (
    <div className={`flow-tool-card default-tool-card status-${status} ${showConfirmationHighlight ? 'requires-confirmation' : ''}`}>
      <div className="tool-card-header">
        <div className="tool-info">
          <span className="tool-icon">{config.icon}</span>
          <div className="tool-details">
            <div className="tool-name">{config.displayName}</div>
            <div className="tool-description">{config.description}</div>
          </div>
        </div>
        <div className="tool-status">
          <span className="status-icon">{getStatusIcon()}</span>
          <span className="status-text">{getStatusText()}</span>
        </div>
      </div>

      {toolCall && (
        <div className="tool-input">
          <div className="input-label">{t('toolCards.common.inputParams')}:</div>
          <div className="input-content">
            {(() => {
              if (!toolCall.input) {
                return <div className="input-parsing">{t('toolCards.readFile.parsingParams')}</div>;
              }
              
              const filteredInput = Object.keys(toolCall.input)
                .filter(key => !key.startsWith('_'))
                .reduce((obj, key) => {
                  obj[key] = toolCall.input[key];
                  return obj;
                }, {} as Record<string, any>);
              
              if (Object.keys(filteredInput).length === 0) {
                return <div className="input-parsing">{t('toolCards.readFile.parsingParams')}</div>;
              }
              
              return <pre>{JSON.stringify(filteredInput, null, 2)}</pre>;
            })()}
          </div>
        </div>
      )}

      {requiresConfirmation && !userConfirmed && status !== 'completed' && (
        <div className="tool-actions">
          <button 
            className="confirm-button"
            onClick={handleConfirm}
            disabled={status === 'streaming'}
          >
            {t('toolCards.mcp.confirmExecute')}
          </button>
          <button 
            className="reject-button"
            onClick={handleReject}
            disabled={status === 'streaming'}
          >
            {t('toolCards.mcp.cancel')}
          </button>
        </div>
      )}

      {toolResult && config.resultDisplayType !== 'hidden' && (
        <div className="tool-result">
          <div className="result-label">{t('toolCards.common.executionResult')}:</div>
          <div className="result-content">
            {toolResult.success ? (
              <div className="result-success">
                <pre>{JSON.stringify(toolResult.result, null, 2)}</pre>
              </div>
            ) : (
              <div className="result-error">
                <div className="error-message">{toolResult.error || t('toolCards.default.failed')}</div>
              </div>
            )}
          </div>
          {config.resultDisplayType === 'summary' && (
            <button className="expand-button" onClick={onExpand}>
              {t('toolCards.common.viewDetails')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};


