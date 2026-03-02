import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, ConfigPageLoading } from '@/component-library';
import { ConfigPageHeader, ConfigPageLayout, ConfigPageContent, ConfigPageSection, ConfigPageRow } from './common';
import { aiExperienceConfigService } from '../services/AIExperienceConfigService';
import { configManager } from '../services/ConfigManager';
import { useNotification, notificationService } from '@/shared/notification-system';
import type { AIModelConfig } from '../types';
import { ModelSelectionRadio } from './ModelSelectionRadio';
import { createLogger } from '@/shared/utils/logger';
import './AIFeaturesConfig.scss';

const log = createLogger('SessionConfig');

type DefaultSessionMode = 'code' | 'cowork';

const DEFAULT_MODE_CONFIG_KEY = 'app.session_config.default_mode';

interface AIExperienceSettings {
  enable_session_title_generation: boolean;
  enable_welcome_panel_ai_analysis: boolean;
}

const defaultSettings: AIExperienceSettings = {
  enable_session_title_generation: true,
  enable_welcome_panel_ai_analysis: true,
};

const AGENT_SESSION_TITLE   = 'session-title-func-agent';
const AGENT_WELCOME_ANALYSIS = 'welcome-panel-func-agent';

const SessionConfig: React.FC = () => {
  const { t } = useTranslation('settings/session-config');
  const notification = useNotification();

  const [isLoading, setIsLoading] = useState(true);
  const [defaultMode, setDefaultMode] = useState<DefaultSessionMode>('code');
  const [settings, setSettings] = useState<AIExperienceSettings>(defaultSettings);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [funcAgentModels, setFuncAgentModels] = useState<Record<string, string>>({});

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setIsLoading(true);
    try {
      const [
        loadedMode,
        loadedSettings,
        allModels,
        funcAgentModelsData,
      ] = await Promise.all([
        configManager.getConfig<DefaultSessionMode>(DEFAULT_MODE_CONFIG_KEY),
        aiExperienceConfigService.getSettingsAsync(),
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<Record<string, string>>('ai.func_agent_models') || {},
      ]);

      setDefaultMode(loadedMode ?? 'code');
      setSettings(loadedSettings);
      setModels(allModels as AIModelConfig[]);
      setFuncAgentModels(funcAgentModelsData as Record<string, string>);
    } catch (error) {
      log.error('Failed to load session config data', error);
      setSettings(defaultSettings);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDefaultModeChange = async (mode: DefaultSessionMode) => {
    setDefaultMode(mode);
    try {
      await configManager.setConfig(DEFAULT_MODE_CONFIG_KEY, mode);
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save default session mode', error);
      notification.error(t('messages.saveFailed'));
      setDefaultMode(defaultMode);
    }
  };

  const updateSetting = async <K extends keyof AIExperienceSettings>(
    key: K,
    value: AIExperienceSettings[K]
  ) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    try {
      await aiExperienceConfigService.saveSettings(newSettings);
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save AI features settings', error);
      notification.error(t('messages.saveFailed'));
      setSettings(settings);
    }
  };

  const getModelName = useCallback((modelId: string | null | undefined): string | undefined => {
    if (!modelId) return undefined;
    return models.find(m => m.id === modelId)?.name;
  }, [models]);

  const handleAgentModelChange = async (agentKey: string, featureTitleKey: string, modelId: string) => {
    try {
      const current = await configManager.getConfig<Record<string, string>>('ai.func_agent_models') || {};
      const updated = { ...current, [agentKey]: modelId };
      await configManager.setConfig('ai.func_agent_models', updated);
      setFuncAgentModels(updated);

      let modelDesc = '';
      if (modelId === 'primary') {
        modelDesc = t('model.primary');
      } else if (modelId === 'fast') {
        modelDesc = t('model.fast');
      } else {
        modelDesc = getModelName(modelId) || modelId || '';
      }

      notificationService.success(
        t('models.updateSuccess', { agentName: t(featureTitleKey), modelName: modelDesc }),
        { duration: 2000 }
      );
    } catch (error) {
      log.error('Failed to update agent model', { agentKey, modelId, error });
      notificationService.error(t('messages.updateFailed'), { duration: 3000 });
    }
  };

  const enabledModels = models.filter((m: AIModelConfig) => m.enabled);
  const sessionTitleModelId   = funcAgentModels[AGENT_SESSION_TITLE]   || 'fast';
  const welcomeAnalysisModelId = funcAgentModels[AGENT_WELCOME_ANALYSIS] || 'fast';

  if (isLoading) {
    return (
      <ConfigPageLayout className="bitfun-func-agent-config">
        <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
        <ConfigPageContent className="bitfun-func-agent-config__content">
          <ConfigPageLoading text={t('loading.text')} />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  return (
    <ConfigPageLayout className="bitfun-func-agent-config">
      <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />

      <ConfigPageContent className="bitfun-func-agent-config__content">

        {/* Default session mode */}
        <ConfigPageSection
          title={t('sections.defaultMode.title')}
          description={t('sections.defaultMode.description')}
        >
          <ConfigPageRow label={t('sections.defaultMode.code')} description={t('sections.defaultMode.codeDesc')} align="center">
            <div className="bitfun-func-agent-config__row-control">
              <input
                type="radio"
                name="default-session-mode"
                value="code"
                checked={defaultMode === 'code'}
                onChange={() => handleDefaultModeChange('code')}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow label={t('sections.defaultMode.cowork')} description={t('sections.defaultMode.coworkDesc')} align="center">
            <div className="bitfun-func-agent-config__row-control">
              <input
                type="radio"
                name="default-session-mode"
                value="cowork"
                checked={defaultMode === 'cowork'}
                onChange={() => handleDefaultModeChange('cowork')}
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        {/* Session title auto generation */}
        <ConfigPageSection
          title={t('features.sessionTitle.title')}
          description={t('features.sessionTitle.subtitle')}
        >
          <ConfigPageRow label={t('common.enable')} align="center">
            <div className="bitfun-func-agent-config__row-control">
              <Switch
                checked={settings.enable_session_title_generation}
                onChange={(e) => updateSetting('enable_session_title_generation', e.target.checked)}
                size="small"
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            className="bitfun-func-agent-config__model-row"
            label={t('model.label')}
            description={enabledModels.length === 0 ? t('models.empty') : undefined}
            align="center"
          >
            <div className="bitfun-func-agent-config__row-control bitfun-func-agent-config__row-control--model">
              <ModelSelectionRadio
                value={sessionTitleModelId}
                models={enabledModels}
                onChange={(modelId) => handleAgentModelChange(AGENT_SESSION_TITLE, 'features.sessionTitle.title', modelId)}
                layout="horizontal"
                size="small"
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        {/* Welcome panel AI analysis */}
        <ConfigPageSection
          title={t('features.welcomeAnalysis.title')}
          description={t('features.welcomeAnalysis.subtitle')}
        >
          <ConfigPageRow label={t('common.enable')} align="center">
            <div className="bitfun-func-agent-config__row-control">
              <Switch
                checked={settings.enable_welcome_panel_ai_analysis}
                onChange={(e) => updateSetting('enable_welcome_panel_ai_analysis', e.target.checked)}
                size="small"
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            className="bitfun-func-agent-config__model-row"
            label={t('model.label')}
            description={enabledModels.length === 0 ? t('models.empty') : undefined}
            align="center"
          >
            <div className="bitfun-func-agent-config__row-control bitfun-func-agent-config__row-control--model">
              <ModelSelectionRadio
                value={welcomeAnalysisModelId}
                models={enabledModels}
                onChange={(modelId) => handleAgentModelChange(AGENT_WELCOME_ANALYSIS, 'features.welcomeAnalysis.title', modelId)}
                layout="horizontal"
                size="small"
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default SessionConfig;
