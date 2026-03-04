/**
 * Skill tool display component.
 * Refactored from the BaseToolCard patterns.
 */

import React from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CubeLoading } from '../../component-library';
import type { ToolCardProps } from '../types/flow-chat';
import { BaseToolCard, ToolCardHeader } from './BaseToolCard';
import './SkillDisplay.scss';

export const SkillDisplay: React.FC<ToolCardProps> = ({
  toolItem
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, status } = toolItem;

  const getSkillInfo = () => {
    if (!toolResult?.result) return null;
    const result = toolResult.result;
    return {
      name: result.skill_name || result.name || t('toolCards.skill.unknownSkill'),
      location: result.location || 'unknown',
    };
  };

  const skillInfo = getSkillInfo();
  const commandName = toolCall?.input?.command || toolCall?.input?.skill_name || t('toolCards.skill.unknown');

  // Map known locations to localized labels.
  const getLocationLabel = (location: string) => {
    switch (location) {
      case 'user':
      case 'personal':
        return t('toolCards.skill.userLevel');
      case 'project':
        return t('toolCards.skill.projectLevel');
      default:
        return location;
    }
  };

  const isLoading = status === 'preparing' || status === 'streaming' || status === 'running';

  const isFailed = status === 'error';

  const getErrorMessage = () => {
    if (toolResult && 'error' in toolResult) {
      return toolResult.error;
    }
    return t('toolCards.skill.loadSkillFailed');
  };

  const renderToolIcon = () => {
    return <Sparkles size={16} />;
  };

  const renderStatusIcon = () => {
    if (isLoading) {
      return <CubeLoading size="small" />;
    }
    return null;
  };

  const renderHeader = () => (
    <ToolCardHeader
      icon={renderToolIcon()}
      iconClassName="skill-icon"
      action={isFailed ? t('toolCards.skill.loadSkillFailed') : t('toolCards.skill.skillAction')}
      content={
        <span className="skill-name-wrapper">
          {status === 'completed' && skillInfo ? (
            <>
              <span className="skill-name">{skillInfo.name}</span>
              {skillInfo.location && (
                <span className={`location-tag location-${skillInfo.location}`}>
                  {getLocationLabel(skillInfo.location)}
                </span>
              )}
            </>
          ) : (
            <span className="skill-name">{commandName}</span>
          )}
        </span>
      }
      statusIcon={renderStatusIcon()}
    />
  );

  const renderErrorContent = () => (
    <div className="error-content">
      <div className="error-message">{getErrorMessage()}</div>
      {commandName && (
        <div className="error-meta">
          <span className="error-skill">{t('toolCards.skill.skillAction')} {commandName}</span>
        </div>
      )}
    </div>
  );

  return (
    <BaseToolCard
      status={status}
      isExpanded={false}
      className="skill-display"
      header={renderHeader()}
      errorContent={renderErrorContent()}
      isFailed={isFailed}
    />
  );
};
