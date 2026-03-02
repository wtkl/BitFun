import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { flowChatStore } from '../store/FlowChatStore';
import { FlowChatState, Session } from '../types/flow-chat';
import { Tooltip } from '@/component-library';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import './CurrentSessionTitle.scss';

const DEFAULT_MODE_CONFIG_KEY = 'app.session_config.default_mode';

interface CurrentSessionTitleProps {
  onCreateSession?: () => void;
}

/**
 * Current session title component.
 * Renders the active session name in the header.
 */
const CurrentSessionTitle: React.FC<CurrentSessionTitleProps> = ({ onCreateSession }) => {
  const { t } = useTranslation('flow-chat');
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => 
    flowChatStore.getState()
  );
  const [defaultMode, setDefaultMode] = useState<'code' | 'cowork'>('code');

  // Subscribe to FlowChatStore updates to keep the title in sync.
  useEffect(() => {
    const unsubscribe = flowChatStore.subscribe((state) => {
      setFlowChatState(state);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    configManager.getConfig<'code' | 'cowork'>(DEFAULT_MODE_CONFIG_KEY).then(mode => {
      if (mode === 'code' || mode === 'cowork') setDefaultMode(mode);
    }).catch(() => {});
    const unwatch = configManager.watch(DEFAULT_MODE_CONFIG_KEY, () => {
      configManager.getConfig<'code' | 'cowork'>(DEFAULT_MODE_CONFIG_KEY).then(mode => {
        if (mode === 'code' || mode === 'cowork') setDefaultMode(mode);
      }).catch(() => {});
    });
    return () => unwatch();
  }, []);

  const activeSession: Session | undefined = flowChatState.activeSessionId 
    ? flowChatState.sessions.get(flowChatState.activeSessionId)
    : undefined;

  const getSessionTitle = (session: Session | undefined): string => {
    if (!session) {
      return t('session.noSession');
    }
    return session.title || t('session.new');
  };

  const title = getSessionTitle(activeSession);

  const handleCreateSession = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCreateSession) {
      onCreateSession();
    }
  };

  const newSessionLabel = defaultMode === 'cowork' ? t('session.newCowork') : t('session.newCode');

  return (
    <div className="bitfun-current-session-title">
      <span className="bitfun-current-session-title__text">{title}</span>
      <Tooltip content={newSessionLabel} placement="bottom">
        <button
          className="bitfun-current-session-title__create-btn"
          onClick={handleCreateSession}
          aria-label={newSessionLabel}
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </div>
  );
};

export default CurrentSessionTitle;
export { CurrentSessionTitle };
