/**
 * Linter tool display component
 * Simple gray text prompt, supports expanding to view linter error list
 */

import React, { useState, useMemo } from 'react';
import { Loader2, CheckCircle, XCircle, AlertTriangle, Clock, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { CompactToolCard, CompactToolCardHeader } from './CompactToolCard';
import { createLogger } from '@/shared/utils/logger';
import './LinterToolCard.scss';

const log = createLogger('LinterToolCard');

interface Diagnostic {
  severity: number;
  severity_text: string;
  line: number;
  column: number;
  message: string;
  code?: string;
  source?: string;
}

interface FileDiagnostics {
  file_path: string;
  language?: string;
  lsp_status: string;
  items: Diagnostic[];
  error_count: number;
  warning_count: number;
  info_count: number;
  hint_count: number;
}

interface DiagnosticSummary {
  total_files: number;
  files_with_issues: number;
  total_diagnostics: number;
  error_count: number;
  warning_count: number;
  info_count: number;
  hint_count: number;
}

interface LinterResult {
  path_type: string;
  path: string;
  diagnostics: Record<string, FileDiagnostics>;
  summary: DiagnosticSummary;
  warnings: string[];
}

interface FlattenedError extends Diagnostic {
  file_path: string;
}

export const LinterToolCard: React.FC<ToolCardProps> = React.memo(({
  toolItem
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, status } = toolItem;
  const [isExpanded, setIsExpanded] = useState(false);

  const getStatusIcon = () => {
    switch (status) {
      case 'running':
      case 'streaming':
        return <Loader2 className="animate-spin" size={12} />;
      case 'completed':
        return <Check size={12} className="icon-check-done" />;
      case 'pending':
      default:
        return <Clock size={12} />;
    }
  };

  const linterData = useMemo<LinterResult | null>(() => {
    if (!toolResult?.result) return null;

    try {
      const result = toolResult.result;
      
      if (typeof result === 'string') {
        const parsed = JSON.parse(result);
        return parsed;
      }
      
      if (typeof result === 'object' && result.summary) {
        return result as LinterResult;
      }

      return null;
    } catch (error) {
      log.error('Failed to parse linter result', error);
      return null;
    }
  }, [toolResult?.result]);

  const filePaths = useMemo(() => {
    const path = toolCall?.input?.path;
    if (!path) {
      const isEarlyDetection = toolCall?.input?._early_detection === true;
      const isPartialParams = toolCall?.input?._partial_params === true;
      if (isEarlyDetection || isPartialParams) {
        return t('toolCards.linter.parsingParams');
      }
    }
    return path || t('toolCards.linter.parsingParams');
  }, [toolCall?.input]);

  const summary = useMemo(() => {
    if (!linterData) return null;

    const flattenedErrors: FlattenedError[] = [];
    Object.entries(linterData.diagnostics).forEach(([_, fileDiag]) => {
      fileDiag.items.forEach(item => {
        flattenedErrors.push({
          ...item,
          file_path: fileDiag.file_path
        });
      });
    });

    return {
      totalErrors: linterData.summary.error_count || 0,
      totalWarnings: linterData.summary.warning_count || 0,
      totalFiles: linterData.summary.total_files || 0,
      errorList: flattenedErrors
    };
  }, [linterData]);

  const getSeverityIcon = (severity: number) => {
    switch (severity) {
      case 1:
        return <XCircle size={12} style={{ color: '#ef4444' }} />;
      case 2:
        return <AlertTriangle size={12} style={{ color: '#f59e0b' }} />;
      case 3:
        return <CheckCircle size={12} style={{ color: '#3b82f6' }} />;
      case 4:
        return <CheckCircle size={12} style={{ color: '#6b7280' }} />;
      default:
        return <CheckCircle size={12} style={{ color: '#6b7280' }} />;
    }
  };

  const getSeverityClass = (severity: number) => {
    switch (severity) {
      case 1: return 'error';
      case 2: return 'warning';
      case 3: return 'info';
      case 4: return 'hint';
      default: return 'info';
    }
  };

  const hasErrors = summary && (summary.totalErrors > 0 || summary.totalWarnings > 0);

  const handleCardClick = () => {
    if (hasErrors) {
      setIsExpanded(!isExpanded);
    }
  };

  const renderContent = () => {
    if (status === 'completed') {
      return (
        <>
          {t('toolCards.linter.checkingCode')}: {filePaths}
          {summary && (
            <span style={{ marginLeft: '8px', fontSize: '11px' }}>
              — {summary.totalErrors > 0 && (
                <span>
                  {summary.totalErrors} {t('toolCards.linter.errors')}
                </span>
              )}
              {summary.totalErrors > 0 && summary.totalWarnings > 0 && ', '}
              {summary.totalWarnings > 0 && (
                <span>
                  {summary.totalWarnings} {t('toolCards.linter.warnings')}
                </span>
              )}
              {summary.totalErrors === 0 && summary.totalWarnings === 0 && (
                <span>
                  {t('toolCards.linter.noIssues')}
                </span>
              )}
            </span>
          )}
        </>
      );
    }
    if (status === 'running' || status === 'streaming') {
      return <>{t('toolCards.linter.checking')} {filePaths}...</>;
    }
    if (status === 'pending') {
      return <>{t('toolCards.linter.preparing')} {filePaths}</>;
    }
    if (status === 'error') {
      return <>{t('toolCards.linter.checkFailed')} {toolResult?.error || t('toolCards.linter.unknownError')}</>;
    }
    return null;
  };

  const expandedContent = useMemo(() => {
    if (!hasErrors || !summary) return null;
    
    return (
      <div className="linter-details">
        {summary.errorList.map((error, index) => (
          <div 
            key={index} 
            className={`linter-error-item severity-${getSeverityClass(error.severity)}`}
          >
            <div className="error-header">
              {getSeverityIcon(error.severity)}
              <span className="error-location">
                {error.file_path}:{error.line}:{error.column}
              </span>
              {error.code && (
                <span className="error-code">[{error.code}]</span>
              )}
            </div>
            <div className="error-message">{error.message}</div>
          </div>
        ))}
      </div>
    );
  }, [hasErrors, summary]);

  const normalizedStatus = status === 'analyzing' ? 'running' : status;

  return (
    <CompactToolCard
      status={normalizedStatus as 'pending' | 'preparing' | 'streaming' | 'running' | 'completed' | 'error' | 'cancelled'}
      isExpanded={isExpanded}
      onClick={handleCardClick}
      className="linter-card"
      clickable={!!hasErrors}
      header={
        <CompactToolCardHeader
          statusIcon={getStatusIcon()}
          content={renderContent()}
        />
      }
      expandedContent={expandedContent ?? undefined}
    />
  );
});

