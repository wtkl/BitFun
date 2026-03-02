import React, { useState, useCallback, useEffect } from 'react';
import { Bot, SlidersHorizontal, Wrench, RotateCcw, Pencil, X, Plus } from 'lucide-react';

import { useTranslation } from 'react-i18next';
import { Search, Switch, IconButton, Badge } from '@/component-library';
import {
  useTeamStore,
  type AgentWithCapabilities,
  type AgentKind,
} from '../teamStore';
import { CAPABILITY_ACCENT } from '../teamIcons';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { SubagentAPI } from '@/infrastructure/api/service-api/SubagentAPI';
import type { SubagentSource } from '@/infrastructure/api/service-api/SubagentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import type { ModeConfigItem } from '@/infrastructure/config/types';
import { useNotification } from '@/shared/notification-system';
import './TeamHomePage.scss';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolInfo {
  name: string;
  description: string;
  is_readonly: boolean;
}

// ─── Agent badge ──────────────────────────────────────────────────────────────

interface AgentBadgeConfig {
  variant: 'accent' | 'info' | 'success' | 'purple' | 'neutral';
  label: string;
}

function getAgentBadge(agentKind?: AgentKind, source?: SubagentSource): AgentBadgeConfig {
  if (agentKind === 'mode') {
    return { variant: 'accent', label: 'Agent' };
  }
  switch (source) {
    case 'user':    return { variant: 'success', label: '用户 Sub-Agent' };
    case 'project': return { variant: 'purple',  label: '项目 Sub-Agent' };
    default:        return { variant: 'info',    label: 'Sub-Agent' };
  }
}

// ─── Enrich capabilities ──────────────────────────────────────────────────────

function enrichCapabilities(agent: AgentWithCapabilities): AgentWithCapabilities {
  if (agent.capabilities?.length) return agent;
  const id   = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();

  if (agent.agentKind === 'mode') {
    if (id === 'agentic') return { ...agent, capabilities: [{ category: '编码', level: 5 }, { category: '分析', level: 4 }] };
    if (id === 'plan')    return { ...agent, capabilities: [{ category: '分析', level: 5 }, { category: '文档', level: 3 }] };
    if (id === 'debug')   return { ...agent, capabilities: [{ category: '编码', level: 5 }, { category: '分析', level: 3 }] };
    if (id === 'cowork')  return { ...agent, capabilities: [{ category: '分析', level: 4 }, { category: '创意', level: 3 }] };
  }

  if (id === 'explore')     return { ...agent, capabilities: [{ category: '分析', level: 4 }, { category: '编码', level: 3 }] };
  if (id === 'file_finder') return { ...agent, capabilities: [{ category: '分析', level: 3 }, { category: '编码', level: 2 }] };

  if (name.includes('code') || name.includes('debug') || name.includes('test')) {
    return { ...agent, capabilities: [{ category: '编码', level: 4 }] };
  }
  if (name.includes('doc') || name.includes('write')) {
    return { ...agent, capabilities: [{ category: '文档', level: 4 }] };
  }
  return { ...agent, capabilities: [{ category: '分析', level: 3 }] };
}

// ─── Agent list item ──────────────────────────────────────────────────────────

const AgentListItem: React.FC<{
  agent: AgentWithCapabilities;
  soloEnabled: boolean;
  onToggleSolo: (agentId: string, enabled: boolean) => void;
  index: number;
  availableTools: ToolInfo[];
  modeConfig: ModeConfigItem | null;
  onToggleTool: (agentId: string, toolName: string) => Promise<void>;
  onResetTools: (agentId: string) => Promise<void>;
}> = ({ agent, soloEnabled, onToggleSolo, index, availableTools, modeConfig, onToggleTool, onResetTools }) => {
  const { t } = useTranslation('scenes/team');
  const [expanded, setExpanded] = useState(false);
  const [toolsEditing, setToolsEditing] = useState(false);

  const toggleExpand = useCallback(() => setExpanded((v) => !v), []);

  const badge = getAgentBadge(agent.agentKind, agent.subagentSource);

  const isMode = agent.agentKind === 'mode';
  const enabledTools = modeConfig?.available_tools ?? agent.defaultTools ?? [];
  const totalTools = isMode ? availableTools.length : (agent.defaultTools?.length ?? 0);

  return (
    <div
      className={['th-list__item', expanded && 'is-expanded'].filter(Boolean).join(' ')}
      style={{ '--item-index': index } as React.CSSProperties}
    >
      <div
        className="th-list__item-row"
        onClick={toggleExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && toggleExpand()}
      >
        <div className="th-list__item-info">
          <div className="th-list__item-name-row">
            <span className="th-list__item-name">{agent.name}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {agent.model && (
              <Badge variant="neutral">{agent.model}</Badge>
            )}
          </div>
          <p className="th-list__item-desc">{agent.description}</p>
        </div>

        <div className="th-list__item-meta">
          {agent.capabilities.slice(0, 3).map((cap) => (
            <span key={cap.category} className="th-list__cap-chip">
              {cap.category}
            </span>
          ))}
        </div>

        <div className="th-list__item-action" onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={soloEnabled}
            onChange={() => onToggleSolo(agent.id, !soloEnabled)}
            size="small"
          />
          <IconButton
            variant="ghost"
            size="small"
            tooltip={t('manage')}
          >
            <SlidersHorizontal size={14} />
          </IconButton>
        </div>
      </div>

      {expanded && (
        <div className="th-list__item-details">
          <p className="th-list__detail-desc">{agent.description}</p>

          {/* 能力评级 */}
          <div className="th-list__cap-grid">
            {agent.capabilities.map((cap) => (
              <div key={cap.category} className="th-list__cap-row">
                <span
                  className="th-list__cap-label"
                  style={{ color: CAPABILITY_ACCENT[cap.category] }}
                >
                  {cap.category}
                </span>
                <div className="th-list__cap-bar">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <span
                      key={i}
                      className={`th-list__cap-pip${i < cap.level ? ' is-filled' : ''}`}
                      style={
                        i < cap.level
                          ? ({ backgroundColor: CAPABILITY_ACCENT[cap.category] } as React.CSSProperties)
                          : undefined
                      }
                    />
                  ))}
                </div>
                <span className="th-list__cap-level">{cap.level}/5</span>
              </div>
            ))}
          </div>

          {/* 工具管理区块 */}
          {totalTools > 0 && (
            <div className="th-list__tools-section">
              {/* 标题行 */}
              <div className="th-list__tools-header">
                <Wrench size={11} />
                <span className="th-list__tools-label">{t('agentsOverview.tools', '工具')}</span>
                <span className="th-list__tools-count">
                  {isMode ? `${enabledTools.length}/${totalTools}` : totalTools}
                </span>

                {/* mode agent：编辑 / 取消 + 重置 */}
                {isMode && (
                  <div className="th-list__tools-actions" onClick={(e) => e.stopPropagation()}>
                    {toolsEditing ? (
                      <>
                        <IconButton
                          size="small"
                          variant="ghost"
                          tooltip={t('agentsOverview.toolsReset', '重置默认')}
                          onClick={() => onResetTools(agent.id)}
                        >
                          <RotateCcw size={12} />
                        </IconButton>
                        <IconButton
                          size="small"
                          variant="ghost"
                          tooltip={t('agentsOverview.toolsCancel', '取消编辑')}
                          onClick={() => setToolsEditing(false)}
                        >
                          <X size={12} />
                        </IconButton>
                      </>
                    ) : (
                      <IconButton
                        size="small"
                        variant="ghost"
                        tooltip={t('agentsOverview.toolsEdit', '管理工具')}
                        onClick={() => setToolsEditing(true)}
                      >
                        <Pencil size={12} />
                      </IconButton>
                    )}
                  </div>
                )}
              </div>

              {/* mode agent 编辑态：全部工具可点击切换 */}
              {isMode && toolsEditing && (
                <div className="th-list__tools-panel" onClick={(e) => e.stopPropagation()}>
                  {[...availableTools]
                    .sort((a, b) => {
                      const aOn = enabledTools.includes(a.name);
                      const bOn = enabledTools.includes(b.name);
                      if (aOn && !bOn) return -1;
                      if (!aOn && bOn) return 1;
                      return 0;
                    })
                    .map((tool) => {
                      const isOn = enabledTools.includes(tool.name);
                      return (
                        <button
                          key={tool.name}
                          type="button"
                          className={`th-list__tool-item${isOn ? ' is-on' : ''}`}
                          title={tool.description || tool.name}
                          onClick={() => onToggleTool(agent.id, tool.name)}
                        >
                          <span className="th-list__tool-item-name">{tool.name}</span>
                        </button>
                      );
                    })}
                </div>
              )}

              {/* mode agent 默认态：只显示已启用的工具 chip */}
              {isMode && !toolsEditing && (
                <div className="th-list__tools-grid">
                  {enabledTools.map((tool) => (
                    <span key={tool} className="th-list__tool-chip" title={tool}>
                      {tool.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}

              {/* sub-agent：只读工具 chip */}
              {!isMode && (
                <div className="th-list__tools-grid">
                  {(agent.defaultTools ?? []).map((tool) => (
                    <span key={tool} className="th-list__tool-chip" title={tool}>
                      {tool.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Filter types ─────────────────────────────────────────────────────────────

type FilterLevel = 'all' | 'builtin' | 'user' | 'project';
type FilterType  = 'all' | 'mode' | 'subagent';

// ─── Page ─────────────────────────────────────────────────────────────────────

const AgentsOverviewPage: React.FC = () => {
  const { t } = useTranslation('scenes/team');
  const { agentSoloEnabled, setAgentSoloEnabled, openCreateAgent } = useTeamStore();
  const notification = useNotification();
  const [query, setQuery] = useState('');
  const [filterLevel, setFilterLevel] = useState<FilterLevel>('all');
  const [filterType, setFilterType]   = useState<FilterType>('all');
  const [allAgents, setAllAgents] = useState<AgentWithCapabilities[]>([]);
  const [loading, setLoading] = useState(true);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [modeConfigs, setModeConfigs] = useState<Record<string, ModeConfigItem>>({});

  const loadAgents = useCallback(async () => {
    setLoading(true);
    const fetchTools = async (): Promise<ToolInfo[]> => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<ToolInfo[]>('get_all_tools_info');
      } catch {
        return [];
      }
    };
    try {
      const [modes, subagents, tools, configs] = await Promise.all([
        agentAPI.getAvailableModes().catch(() => []),
        SubagentAPI.listSubagents().catch(() => []),
        fetchTools(),
        configAPI.getModeConfigs().catch(() => ({})),
      ]);
      const modeAgents: AgentWithCapabilities[] = modes.map((m) =>
        enrichCapabilities({
          id: m.id, name: m.name, description: m.description,
          isReadonly: m.isReadonly, toolCount: m.toolCount,
          defaultTools: m.defaultTools ?? [], enabled: m.enabled,
          capabilities: [], agentKind: 'mode',
        })
      );
      const subAgents: AgentWithCapabilities[] = subagents.map((s) =>
        enrichCapabilities({ ...s, capabilities: [], agentKind: 'subagent' })
      );
      setAllAgents([...modeAgents, ...subAgents]);
      setAvailableTools(tools);
      setModeConfigs(configs as Record<string, ModeConfigItem>);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  // 获取 mode 的有效配置（含默认值回退）
  const getModeConfig = useCallback((agentId: string): ModeConfigItem | null => {
    const agent = allAgents.find((a) => a.id === agentId && a.agentKind === 'mode');
    if (!agent) return null;
    const userConfig = modeConfigs[agentId];
    const defaultTools = agent.defaultTools ?? [];
    if (!userConfig) {
      return { mode_id: agentId, available_tools: defaultTools, enabled: true, default_tools: defaultTools };
    }
    if (!userConfig.available_tools || userConfig.available_tools.length === 0) {
      return { ...userConfig, available_tools: defaultTools, default_tools: defaultTools };
    }
    return { ...userConfig, default_tools: userConfig.default_tools ?? defaultTools };
  }, [allAgents, modeConfigs]);

  const saveModeConfig = useCallback(async (agentId: string, updates: Partial<ModeConfigItem>) => {
    const config = getModeConfig(agentId);
    if (!config) return;
    const updated = { ...config, ...updates };
    await configAPI.setModeConfig(agentId, updated);
    setModeConfigs((prev) => ({ ...prev, [agentId]: updated }));
    try {
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
    } catch { /* ignore */ }
  }, [getModeConfig]);

  const handleToggleTool = useCallback(async (agentId: string, toolName: string) => {
    const config = getModeConfig(agentId);
    if (!config) return;
    const tools = config.available_tools ?? [];
    const isEnabling = !tools.includes(toolName);
    const newTools = isEnabling ? [...tools, toolName] : tools.filter((t) => t !== toolName);
    try {
      await saveModeConfig(agentId, { available_tools: newTools });
    } catch {
      notification.error(t('agentsOverview.toolToggleFailed', '工具切换失败'));
    }
  }, [getModeConfig, saveModeConfig, notification, t]);

  const handleResetTools = useCallback(async (agentId: string) => {
    try {
      await configAPI.resetModeConfig(agentId);
      const updated = await configAPI.getModeConfigs();
      setModeConfigs(updated as Record<string, ModeConfigItem>);
      notification.success(t('agentsOverview.toolsResetSuccess', '已重置为默认工具'));
      try {
        const { globalEventBus } = await import('@/infrastructure/event-bus');
        globalEventBus.emit('mode:config:updated');
      } catch { /* ignore */ }
    } catch {
      notification.error(t('agentsOverview.toolToggleFailed', '重置失败'));
    }
  }, [notification, t]);

  const filteredAgents = allAgents.filter((a) => {
    // 文本搜索
    if (query) {
      const q = query.toLowerCase();
      if (!a.name.toLowerCase().includes(q) && !a.description.toLowerCase().includes(q)) return false;
    }
    // 类型筛选
    if (filterType !== 'all') {
      if (filterType === 'mode' && a.agentKind !== 'mode') return false;
      if (filterType === 'subagent' && a.agentKind !== 'subagent') return false;
    }
    // 级别筛选（mode 归属 builtin）
    if (filterLevel !== 'all') {
      const level = a.agentKind === 'mode' ? 'builtin' : (a.subagentSource ?? 'builtin');
      if (level !== filterLevel) return false;
    }
    return true;
  });

  const LEVEL_FILTERS: { key: FilterLevel; label: string }[] = [
    { key: 'all',     label: t('agentsOverview.filterAll', '全部') },
    { key: 'builtin', label: t('agentsOverview.filterBuiltin', '内置') },
    { key: 'user',    label: t('agentsOverview.filterUser', '用户') },
    { key: 'project', label: t('agentsOverview.filterProject', '项目') },
  ];

  const TYPE_FILTERS: { key: FilterType; label: string }[] = [
    { key: 'all',      label: t('agentsOverview.filterAll', '全部') },
    { key: 'mode',     label: 'Agent' },
    { key: 'subagent', label: 'Sub-Agent' },
  ];

  return (
    <div className="th">
      <div className="th__header">
        <div className="th__header-inner">
          <div className="th__title-row">
            <div>
              <h2 className="th__title">{t('agentsOverview.title')}</h2>
              <p className="th__title-sub">{t('agentsOverview.subtitle')}</p>
            </div>
            <button
              type="button"
              className="th__create-btn"
              onClick={openCreateAgent}
            >
              <Plus size={13} />
              {t('agentsOverview.newAgent', '新建 Agent')}
            </button>
          </div>
          <div className="th__toolbar">
            <Search
              placeholder={t('home.search')}
              value={query}
              onChange={setQuery}
              clearable
              size="small"
            />
          </div>
        </div>
      </div>

      <div className="th__list-body">
        <div className="th__list-inner">
          <div className="th-list__section-head">
            <span className="th-list__section-title">{t('agentsOverview.sectionTitle')}</span>
            <span className="th-list__section-count">{filteredAgents.length}</span>
            <div className="th__filters">
              <div className="th__filter-group">
                {LEVEL_FILTERS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`th__filter-chip${filterLevel === key ? ' is-active' : ''}`}
                    onClick={() => setFilterLevel(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="th__filter-sep" />
              <div className="th__filter-group">
                {TYPE_FILTERS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`th__filter-chip${filterType === key ? ' is-active' : ''}`}
                    onClick={() => setFilterType(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {loading ? (
            <div className="th-list__empty">
              <Bot size={28} strokeWidth={1.5} />
              <span>{t('loading', '加载中…')}</span>
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="th-list__empty">
              <Bot size={28} strokeWidth={1.5} />
              <span>{t('empty')}</span>
            </div>
          ) : (
            <div className="th-list">
              {filteredAgents.map((a, i) => (
                <AgentListItem
                  key={a.id}
                  agent={a}
                  soloEnabled={agentSoloEnabled[a.id] ?? a.enabled}
                  onToggleSolo={setAgentSoloEnabled}
                  index={i}
                  availableTools={availableTools}
                  modeConfig={a.agentKind === 'mode' ? getModeConfig(a.id) : null}
                  onToggleTool={handleToggleTool}
                  onResetTools={handleResetTools}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentsOverviewPage;
