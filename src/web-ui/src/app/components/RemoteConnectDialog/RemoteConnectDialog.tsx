/**
 * Remote Connect dialog — lets the user pick a connection method,
 * displays a QR code (or bot pairing code), and shows pairing status.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useI18n } from '@/infrastructure/i18n';
import { Modal, Badge } from '@/component-library';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import {
  remoteConnectAPI,
  type ConnectionResult,
  type RemoteConnectStatus,
} from '@/infrastructure/api/service-api/RemoteConnectAPI';
import './RemoteConnectDialog.scss';

type ConnectionTab = 'lan' | 'ngrok' | 'bitfun_server' | 'custom_server' | 'bot';
const NGROK_SETUP_URL = 'https://dashboard.ngrok.com/get-started/setup';

interface TabDef {
  id: ConnectionTab;
  labelKey: string;
}

const TABS: TabDef[] = [
  { id: 'lan', labelKey: 'remoteConnect.tabLan' },
  { id: 'ngrok', labelKey: 'remoteConnect.tabNgrok' },
  { id: 'bitfun_server', labelKey: 'remoteConnect.tabBitfunServer' },
  { id: 'custom_server', labelKey: 'remoteConnect.tabCustomServer' },
  { id: 'bot', labelKey: 'remoteConnect.tabBot' },
];

interface RemoteConnectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RemoteConnectDialog: React.FC<RemoteConnectDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useI18n('common');
  const [activeTab, setActiveTab] = useState<ConnectionTab>('bitfun_server');
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [status, setStatus] = useState<RemoteConnectStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [botType, setBotType] = useState<'bot_feishu' | 'bot_telegram'>('bot_telegram');

  // Bot credential fields
  const [tgToken, setTgToken] = useState('');
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isOpen) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isOpen]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await remoteConnectAPI.getStatus();
        setStatus(s);
        if (s.pairing_state === 'connected') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        // ignore
      }
    }, 2000);
  }, []);

  const handleConnect = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConnectionResult(null);
    setStatus(null);

    try {
      let method = activeTab as string;
      let serverUrl: string | undefined;

      if (activeTab === 'bot') {
        method = botType;
        // Save bot credentials first
        if (botType === 'bot_telegram' && tgToken) {
          await remoteConnectAPI.configureBot({ botType: 'telegram', botToken: tgToken });
        } else if (botType === 'bot_feishu' && feishuAppId) {
          await remoteConnectAPI.configureBot({
            botType: 'feishu',
            appId: feishuAppId,
            appSecret: feishuAppSecret,
          });
        }
      } else if (activeTab === 'custom_server') {
        serverUrl = customUrl || undefined;
      }

      const result = await remoteConnectAPI.startConnection(method, serverUrl);
      setConnectionResult(result);
      startPolling();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [activeTab, botType, customUrl, tgToken, feishuAppId, feishuAppSecret, startPolling]);

  const handleDisconnect = useCallback(async () => {
    try {
      await remoteConnectAPI.stopConnection();
      setConnectionResult(null);
      setStatus(null);
    } catch {
      // best effort
    }
  }, []);

  const isConnected = status?.pairing_state === 'connected';
  const isNgrokNotInstalledError = !!error?.includes('ngrok is not installed');

  const handleOpenNgrokSetup = useCallback(() => {
    void systemAPI.openExternal(NGROK_SETUP_URL);
  }, []);

  const renderErrorBlock = () => {
    if (!error) return null;

    return (
      <div className="bitfun-remote-connect__error-group">
        <p className="bitfun-remote-connect__error">{error}</p>
        {isNgrokNotInstalledError && (
          <button
            type="button"
            className="bitfun-remote-connect__error-action"
            onClick={handleOpenNgrokSetup}
          >
            {t('remoteConnect.openNgrokSetup')}
          </button>
        )}
      </div>
    );
  };

  const renderPairingState = () => {
    if (!status) return null;
    const state = status.pairing_state;
    const stateMap: Record<string, { label: string; variant: 'info' | 'warning' | 'success' | 'error' }> = {
      idle: { label: t('remoteConnect.stateIdle'), variant: 'info' },
      waiting_for_scan: { label: t('remoteConnect.stateWaiting'), variant: 'warning' },
      handshaking: { label: t('remoteConnect.stateHandshaking'), variant: 'warning' },
      verifying: { label: t('remoteConnect.stateVerifying'), variant: 'warning' },
      connected: { label: t('remoteConnect.stateConnected'), variant: 'success' },
      disconnected: { label: t('remoteConnect.stateDisconnected'), variant: 'info' },
    };
    const info = stateMap[state] || { label: state, variant: 'info' as const };

    return (
      <div className="bitfun-remote-connect__status">
        <Badge variant={info.variant}>{info.label}</Badge>
        {isConnected && status.peer_device_name && (
          <span className="bitfun-remote-connect__peer-name">
            {status.peer_device_name}
          </span>
        )}
      </div>
    );
  };

  const renderQrCode = () => {
    if (!connectionResult) return null;

    if (connectionResult.qr_url) {
      return (
        <div className="bitfun-remote-connect__qr-box">
          <QRCodeSVG
            value={connectionResult.qr_url}
            size={180}
            level="M"
            includeMargin
          />
        </div>
      );
    }

    if (connectionResult.bot_pairing_code) {
      return (
        <div className="bitfun-remote-connect__pairing-code-box">
          <div className="bitfun-remote-connect__pairing-code">
            {connectionResult.bot_pairing_code}
          </div>
        </div>
      );
    }

    return null;
  };

  const renderBotConfigForm = () => (
    <div className="bitfun-remote-connect__body">
      <div className="bitfun-remote-connect__bot-selector">
        <button
          type="button"
          className={`bitfun-remote-connect__bot-option${botType === 'bot_telegram' ? ' is-active' : ''}`}
          onClick={() => setBotType('bot_telegram')}
        >
          Telegram
        </button>
        <button
          type="button"
          className={`bitfun-remote-connect__bot-option${botType === 'bot_feishu' ? ' is-active' : ''}`}
          onClick={() => setBotType('bot_feishu')}
        >
          {t('remoteConnect.feishu')}
        </button>
      </div>

      {botType === 'bot_telegram' && (
        <div className="bitfun-remote-connect__bot-guide">
          <div className="bitfun-remote-connect__steps">
            <p className="bitfun-remote-connect__step">
              1. {t('remoteConnect.botTgStep1')}
            </p>
            <p className="bitfun-remote-connect__step">
              2. {t('remoteConnect.botTgStep2')}
            </p>
            <p className="bitfun-remote-connect__step">
              3. {t('remoteConnect.botTgStep3')}
            </p>
          </div>
          <div className="bitfun-remote-connect__input-group">
            <label>Bot Token</label>
            <input
              type="text"
              className="bitfun-remote-connect__input"
              placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
            />
          </div>
        </div>
      )}

      {botType === 'bot_feishu' && (
        <div className="bitfun-remote-connect__bot-guide">
          <div className="bitfun-remote-connect__steps">
            <p className="bitfun-remote-connect__step">
              1. {t('remoteConnect.botFeishuStep1')}
            </p>
            <p className="bitfun-remote-connect__step">
              2. {t('remoteConnect.botFeishuStep2')}
            </p>
            <p className="bitfun-remote-connect__step">
              3. {t('remoteConnect.botFeishuStep3')}
            </p>
          </div>
          <div className="bitfun-remote-connect__input-group">
            <label>App ID</label>
            <input
              type="text"
              className="bitfun-remote-connect__input"
              placeholder="cli_xxxxxxxx"
              value={feishuAppId}
              onChange={(e) => setFeishuAppId(e.target.value)}
            />
          </div>
          <div className="bitfun-remote-connect__input-group">
            <label>App Secret</label>
            <input
              type="password"
              className="bitfun-remote-connect__input"
              placeholder="xxxxxxxxxxxxxxxx"
              value={feishuAppSecret}
              onChange={(e) => setFeishuAppSecret(e.target.value)}
            />
          </div>
        </div>
      )}

      {renderErrorBlock()}

      <button
        type="button"
        className="bitfun-remote-connect__btn bitfun-remote-connect__btn--connect"
        onClick={handleConnect}
        disabled={loading || (botType === 'bot_telegram' ? !tgToken : !feishuAppId)}
      >
        {loading ? t('remoteConnect.connecting') : t('remoteConnect.connect')}
      </button>
    </div>
  );

  const renderTabContent = () => {
    if (isConnected) {
      return (
        <div className="bitfun-remote-connect__connected">
          {renderPairingState()}
          <p className="bitfun-remote-connect__hint">
            {t('remoteConnect.connectedHint')}
          </p>
          <button
            type="button"
            className="bitfun-remote-connect__btn bitfun-remote-connect__btn--disconnect"
            onClick={handleDisconnect}
          >
            {t('remoteConnect.disconnect')}
          </button>
        </div>
      );
    }

    if (connectionResult) {
      return (
        <div className="bitfun-remote-connect__body">
          {renderQrCode()}
          {renderPairingState()}
          <p className="bitfun-remote-connect__hint">
            {activeTab === 'bot'
              ? t('remoteConnect.botHint')
              : t('remoteConnect.scanHint')}
          </p>
          <button
            type="button"
            className="bitfun-remote-connect__btn bitfun-remote-connect__btn--cancel"
            onClick={handleDisconnect}
          >
            {t('remoteConnect.cancel')}
          </button>
        </div>
      );
    }

    if (activeTab === 'bot') {
      return renderBotConfigForm();
    }

    return (
      <div className="bitfun-remote-connect__body">
        {activeTab === 'custom_server' && (
          <div className="bitfun-remote-connect__input-group">
            <label>{t('remoteConnect.serverUrl')}</label>
            <input
              type="url"
              className="bitfun-remote-connect__input"
              placeholder="https://relay.example.com"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
            />
          </div>
        )}

        <p className="bitfun-remote-connect__description">
          {t(`remoteConnect.desc_${activeTab}`)}
        </p>

        {renderErrorBlock()}

        <button
          type="button"
          className="bitfun-remote-connect__btn bitfun-remote-connect__btn--connect"
          onClick={handleConnect}
          disabled={loading}
        >
          {loading ? t('remoteConnect.connecting') : t('remoteConnect.connect')}
        </button>
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('remoteConnect.title')}
      showCloseButton
      size="medium"
    >
      <div className="bitfun-remote-connect">
        <div className="bitfun-remote-connect__tabs">
          {TABS.map((tab, i) => (
            <React.Fragment key={tab.id}>
              {i > 0 && (
                <span className="bitfun-remote-connect__tab-divider" aria-hidden="true" />
              )}
              <button
                type="button"
                className={`bitfun-remote-connect__tab${activeTab === tab.id ? ' is-active' : ''}`}
                onClick={() => {
                  setActiveTab(tab.id);
                  setConnectionResult(null);
                  setStatus(null);
                  setError(null);
                }}
                disabled={!!connectionResult}
              >
                {t(tab.labelKey)}
              </button>
            </React.Fragment>
          ))}
        </div>

        {renderTabContent()}
      </div>
    </Modal>
  );
};

export default RemoteConnectDialog;
