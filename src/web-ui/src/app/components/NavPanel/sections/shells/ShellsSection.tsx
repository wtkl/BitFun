/**
 * ShellsSection — inline accordion content for the "Shell" nav item.
 *
 * Shows a combined list of:
 *   • Hub terminals (configured entries from localStorage, running or stopped)
 *   • Ad-hoc active sessions (non-hub sessions from the terminal service)
 *
 * Only mounts when the accordion is expanded → zero cost when collapsed.
 *
 * Click behavior:
 *   • Current scene is 'session' → open terminal as an AuxPane tab
 *     (stays inside the agent scene)
 *   • Any other scene → switch to terminal scene and show the terminal
 *     content directly (via terminalSceneStore)
 *
 * For stopped hub entries, clicking starts the terminal process first.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, SquareTerminal, Circle, Trash2, Square, Edit2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getTerminalService } from '../../../../../tools/terminal';
import type { TerminalService } from '../../../../../tools/terminal';
import type { SessionResponse, TerminalEvent } from '../../../../../tools/terminal/types/session';
import { createTerminalTab } from '../../../../../shared/utils/tabUtils';
import { useTerminalSceneStore } from '../../../../stores/terminalSceneStore';
import { resolveAndFocusOpenTarget } from '../../../../../shared/services/sceneOpenTargetResolver';
import { useCurrentWorkspace } from '../../../../../infrastructure/contexts/WorkspaceContext';
import { configManager } from '../../../../../infrastructure/config/services/ConfigManager';
import type { TerminalConfig } from '../../../../../infrastructure/config/types';
import { Tooltip } from '@/component-library';
import { TerminalEditModal } from '../../../panels/TerminalEditModal';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ShellsSection');

// ── Hub config (shared localStorage schema for terminal hub) ─────────────────

const TERMINAL_HUB_STORAGE_KEY = 'bitfun-terminal-hub-config';
const HUB_TERMINAL_ID_PREFIX = 'hub_';

interface HubTerminalEntry {
  sessionId: string;
  name: string;
  startupCommand?: string;
}

interface HubConfig {
  terminals: HubTerminalEntry[];
  worktrees: Record<string, HubTerminalEntry[]>;
}

function loadHubConfig(workspacePath: string): HubConfig {
  try {
    const raw = localStorage.getItem(`${TERMINAL_HUB_STORAGE_KEY}:${workspacePath}`);
    if (raw) return JSON.parse(raw) as HubConfig;
  } catch {}
  return { terminals: [], worktrees: {} };
}

function saveHubConfig(workspacePath: string, config: HubConfig) {
  try {
    localStorage.setItem(`${TERMINAL_HUB_STORAGE_KEY}:${workspacePath}`, JSON.stringify(config));
  } catch (err) {
    log.error('Failed to save hub config', err);
  }
}

interface ShellEntry {
  sessionId: string;
  name: string;
  isRunning: boolean;
  isHub: boolean;
  worktreePath?: string;
  startupCommand?: string;
}

const ShellsSection: React.FC = () => {
  const { t } = useTranslation('panels/terminal');
  const setActiveSession = useTerminalSceneStore(s => s.setActiveSession);
  const { workspacePath } = useCurrentWorkspace();

  const [sessions, setSessions] = useState<SessionResponse[]>([]);
  const [hubConfig, setHubConfig] = useState<HubConfig>({ terminals: [], worktrees: {} });
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingTerminal, setEditingTerminal] = useState<{
    terminal: HubTerminalEntry;
    worktreePath?: string;
  } | null>(null);
  const serviceRef = useRef<TerminalService | null>(null);

  const runningIds = useMemo(() => new Set(sessions.map(s => s.id)), [sessions]);

  useEffect(() => {
    if (!workspacePath) return;
    setHubConfig(loadHubConfig(workspacePath));
  }, [workspacePath]);

  const refreshSessions = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    try {
      setSessions(await service.listSessions());
    } catch (err) {
      log.error('Failed to list sessions', err);
    }
  }, []);

  useEffect(() => {
    const service = getTerminalService();
    serviceRef.current = service;

    const init = async () => {
      try {
        await service.connect();
        await refreshSessions();
      } catch (err) {
        log.error('Failed to connect terminal service', err);
      }
    };

    init();

    const unsub = service.onEvent((event: TerminalEvent) => {
      if (event.type === 'ready' || event.type === 'exit') {
        refreshSessions();
      }
    });

    return () => unsub();
  }, [refreshSessions]);

  const entries = useMemo<ShellEntry[]>(() => {
    const result: ShellEntry[] = [];

    // Hub terminals (main + all worktrees)
    for (const t of hubConfig.terminals) {
      result.push({
        sessionId: t.sessionId,
        name: t.name,
        isRunning: runningIds.has(t.sessionId),
        isHub: true,
        startupCommand: t.startupCommand,
      });
    }
    for (const [wtPath, terms] of Object.entries(hubConfig.worktrees)) {
      for (const t of terms) {
        result.push({
          sessionId: t.sessionId,
          name: t.name,
          isRunning: runningIds.has(t.sessionId),
          isHub: true,
          worktreePath: wtPath,
          startupCommand: t.startupCommand,
        });
      }
    }

    // Ad-hoc active sessions (not managed by hub)
    for (const s of sessions) {
      if (!s.id.startsWith(HUB_TERMINAL_ID_PREFIX)) {
        result.push({
          sessionId: s.id,
          name: s.name,
          isRunning: true,
          isHub: false,
        });
      }
    }

    return result;
  }, [hubConfig, sessions, runningIds]);

  const startHubTerminal = useCallback(
    async (entry: ShellEntry): Promise<boolean> => {
      const service = serviceRef.current;
      if (!service || !workspacePath) return false;

      try {
        let shellType: string | undefined;
        try {
          const cfg = await configManager.getConfig<TerminalConfig>('terminal');
          if (cfg?.default_shell) shellType = cfg.default_shell;
        } catch {}

        await service.createSession({
          sessionId: entry.sessionId,
          workingDirectory: entry.worktreePath ?? workspacePath,
          name: entry.name,
          shellType,
        });

        if (entry.startupCommand?.trim()) {
          // Brief wait for the shell to initialise before sending command
          await new Promise(r => setTimeout(r, 800));
          try {
            await service.sendCommand(entry.sessionId, entry.startupCommand);
          } catch {}
        }

        await refreshSessions();
        return true;
      } catch (err) {
        log.error('Failed to start hub terminal', err);
        return false;
      }
    },
    [workspacePath, refreshSessions]
  );

  const handleOpen = useCallback(
    async (entry: ShellEntry) => {
      // Start the terminal if it's a hub entry that isn't running yet
      if (!entry.isRunning) {
        const ok = await startHubTerminal(entry);
        if (!ok) return;
      }

      const { mode } = resolveAndFocusOpenTarget('terminal');
      if (mode === 'agent') {
        // Stay in agent scene: open as AuxPane tab
        createTerminalTab(entry.sessionId, entry.name, 'agent');
      } else {
        // Any other scene: navigate to terminal scene and show content directly
        setActiveSession(entry.sessionId);
      }
    },
    [startHubTerminal, setActiveSession]
  );

  const handleCreate = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;

    try {
      let shellType: string | undefined;
      try {
        const cfg = await configManager.getConfig<TerminalConfig>('terminal');
        if (cfg?.default_shell) shellType = cfg.default_shell;
      } catch {}

      const session = await service.createSession({
        workingDirectory: workspacePath,
        name: `Shell ${sessions.length + 1}`,
        shellType,
      });

      setSessions(prev => [...prev, session]);

      const { mode } = resolveAndFocusOpenTarget('terminal');
      if (mode === 'agent') {
        createTerminalTab(session.id, session.name, 'agent');
      } else {
        setActiveSession(session.id);
      }
    } catch (err) {
      log.error('Failed to create shell', err);
    }
  }, [workspacePath, sessions.length, setActiveSession]);

  /**
   * Stop terminal session
   * - For hub terminals: keep in list but stop the process, right panel stays open
   * - For ad-hoc terminals: same as delete (close session and right panel tab)
   */
  const handleStopTerminal = useCallback(
    async (entry: ShellEntry, e: React.MouseEvent) => {
      e.stopPropagation();
      const service = serviceRef.current;
      if (!service || !runningIds.has(entry.sessionId)) return;

      try {
        await service.closeSession(entry.sessionId);

        // For ad-hoc terminals, dispatch destroyed event to close right panel tab
        // (since they won't be preserved in the list anyway)
        if (!entry.isHub) {
          window.dispatchEvent(
            new CustomEvent('terminal-session-destroyed', { detail: { sessionId: entry.sessionId } })
          );
        }

        await refreshSessions();
      } catch (err) {
        log.error('Failed to stop terminal', err);
      }
    },
    [runningIds, refreshSessions]
  );

  /**
   * Delete terminal - close session, close right panel tab, and remove from list
   * For hub terminals: also remove from localStorage config
   */
  const handleDeleteTerminal = useCallback(
    async (entry: ShellEntry, e: React.MouseEvent) => {
      e.stopPropagation();

      // Close the terminal session if running
      if (entry.isRunning) {
        const service = serviceRef.current;
        if (service) {
          try {
            await service.closeSession(entry.sessionId);
          } catch (err) {
            log.error('Failed to close terminal session', err);
          }
        }
      }

      // Dispatch event to close the tab in right panel
      window.dispatchEvent(
        new CustomEvent('terminal-session-destroyed', { detail: { sessionId: entry.sessionId } })
      );

      // For hub terminals, also remove from localStorage config
      if (entry.isHub && workspacePath) {
        setHubConfig(prev => {
          let next: HubConfig;
          if (entry.worktreePath) {
            const terms = (prev.worktrees[entry.worktreePath] || []).filter(
              t => t.sessionId !== entry.sessionId
            );
            next = { ...prev, worktrees: { ...prev.worktrees, [entry.worktreePath]: terms } };
          } else {
            next = { ...prev, terminals: prev.terminals.filter(t => t.sessionId !== entry.sessionId) };
          }
          saveHubConfig(workspacePath, next);
          return next;
        });
      }

      // Refresh the session list
      await refreshSessions();
    },
    [workspacePath, refreshSessions]
  );

  /**
   * Open edit modal for a terminal
   */
  const handleOpenEditModal = useCallback(
    (entry: ShellEntry, e: React.MouseEvent) => {
      e.stopPropagation();

      if (entry.isHub) {
        // For hub terminals, find the entry from config
        let hubEntry: HubTerminalEntry | undefined;
        if (entry.worktreePath) {
          hubEntry = hubConfig.worktrees[entry.worktreePath]?.find(t => t.sessionId === entry.sessionId);
        } else {
          hubEntry = hubConfig.terminals.find(t => t.sessionId === entry.sessionId);
        }

        if (hubEntry) {
          setEditingTerminal({ terminal: hubEntry, worktreePath: entry.worktreePath });
          setEditModalOpen(true);
        }
      } else {
        // For ad-hoc sessions, create a temporary entry for editing
        setEditingTerminal({
          terminal: { sessionId: entry.sessionId, name: entry.name },
          worktreePath: undefined,
        });
        setEditModalOpen(true);
      }
    },
    [hubConfig]
  );

  /**
   * Save terminal edit (name and optionally startup command)
   */
  const handleSaveTerminalEdit = useCallback(
    (newName: string, newStartupCommand?: string) => {
      if (!editingTerminal) return;
      const { terminal, worktreePath } = editingTerminal;

      // For hub terminals, update localStorage config
      if (terminal.sessionId.startsWith(HUB_TERMINAL_ID_PREFIX) && workspacePath) {
        setHubConfig(prev => {
          let next: HubConfig;
          if (worktreePath) {
            const terms = (prev.worktrees[worktreePath] || []).map(t =>
              t.sessionId === terminal.sessionId
                ? { ...t, name: newName, startupCommand: newStartupCommand }
                : t
            );
            next = { ...prev, worktrees: { ...prev.worktrees, [worktreePath]: terms } };
          } else {
            const terms = prev.terminals.map(t =>
              t.sessionId === terminal.sessionId
                ? { ...t, name: newName, startupCommand: newStartupCommand }
                : t
            );
            next = { ...prev, terminals: terms };
          }
          saveHubConfig(workspacePath, next);
          return next;
        });
      }

      // Update session name in state and notify other components
      if (runningIds.has(terminal.sessionId)) {
        setSessions(prev =>
          prev.map(s => (s.id === terminal.sessionId ? { ...s, name: newName } : s))
        );
        window.dispatchEvent(
          new CustomEvent('terminal-session-renamed', {
            detail: { sessionId: terminal.sessionId, newName },
          })
        );
      }

      setEditingTerminal(null);
    },
    [editingTerminal, workspacePath, runningIds]
  );

  const renderTerminalItem = (entry: ShellEntry) => {
    return (
      <button
        key={entry.sessionId}
        type="button"
        className="bitfun-nav-panel__inline-item"
        onClick={() => handleOpen(entry)}
        title={entry.name}
      >
        <SquareTerminal size={12} className="bitfun-nav-panel__inline-item-icon" />
        <span className="bitfun-nav-panel__inline-item-label">{entry.name}</span>
        <Circle
          size={6}
          className={`bitfun-nav-panel__shell-dot ${entry.isRunning ? 'is-running' : 'is-stopped'}`}
        />
        <div className="bitfun-nav-panel__inline-item-actions">
          <Tooltip content={t('actions.edit')}>
            <button
              type="button"
              className="bitfun-nav-panel__inline-item-action-btn"
              onClick={(e) => handleOpenEditModal(entry, e)}
            >
              <Edit2 size={10} />
            </button>
          </Tooltip>
          {entry.isRunning && (
            <Tooltip content={t('actions.stopTerminal')}>
              <button
                type="button"
                className="bitfun-nav-panel__inline-item-action-btn"
                onClick={(e) => handleStopTerminal(entry, e)}
              >
                <Square size={10} />
              </button>
            </Tooltip>
          )}
          <Tooltip content={t('actions.deleteTerminal')}>
            <button
              type="button"
              className="bitfun-nav-panel__inline-item-action-btn delete"
              onClick={(e) => handleDeleteTerminal(entry, e)}
            >
              <Trash2 size={10} />
            </button>
          </Tooltip>
        </div>
      </button>
    );
  };

  return (
    <div className="bitfun-nav-panel__inline-list">
      <button
        type="button"
        className="bitfun-nav-panel__inline-action"
        onClick={handleCreate}
        title="New shell"
      >
        <Plus size={12} />
        <span>New shell</span>
      </button>

      {entries.length === 0 ? (
        <div className="bitfun-nav-panel__inline-empty">No shells</div>
      ) : (
        entries.map(entry => renderTerminalItem(entry))
      )}

      {editingTerminal && (
        <TerminalEditModal
          isOpen={editModalOpen}
          onClose={() => {
            setEditModalOpen(false);
            setEditingTerminal(null);
          }}
          onSave={handleSaveTerminalEdit}
          initialName={editingTerminal.terminal.name}
          initialStartupCommand={editingTerminal.terminal.startupCommand}
        />
      )}
    </div>
  );
};

export default ShellsSection;
