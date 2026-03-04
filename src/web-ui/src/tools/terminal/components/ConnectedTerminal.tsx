/**
 * Connected terminal component that streams a backend session.
 * Optimizations: debounced resize, post-resize refresh, visibility-aware sync.
 */

import React, { useEffect, useRef, useCallback, useState, memo } from 'react';
import { AlertCircle, RefreshCw, Terminal as TerminalIcon, Trash2 } from 'lucide-react';
import Terminal, { TerminalRef } from './Terminal';
import { useTerminal } from '../hooks/useTerminal';
import { registerTerminalActions, unregisterTerminalActions } from '../services/TerminalActionManager';
import { confirmWarning } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import type { SessionResponse } from '../types';
import './Terminal.scss';

const log = createLogger('ConnectedTerminal');

/** Line threshold for multi-line paste confirmation. */
const MULTILINE_PASTE_THRESHOLD = 1;

export interface ConnectedTerminalProps {
  sessionId: string;
  className?: string;
  autoFocus?: boolean;
  showToolbar?: boolean;
  showStatusBar?: boolean;
  /** Optional session data; fetched when omitted. */
  session?: SessionResponse;
  onClose?: () => void;
  onTitleChange?: (title: string) => void;
  onExit?: (exitCode?: number) => void;
}

const ConnectedTerminal: React.FC<ConnectedTerminalProps> = memo(({
  sessionId,
  className = '',
  autoFocus = true,
  showToolbar = false,
  showStatusBar = false,
  session: initialSession,
  onClose,
  onTitleChange,
  onExit,
}) => {
  const terminalRef = useRef<TerminalRef>(null);
  const [title, setTitle] = useState<string>(initialSession?.name || 'Terminal');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isExited, setIsExited] = useState(false);
  const [isTerminalReady, setIsTerminalReady] = useState(false);

  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  // Buffer output until the terminal is ready.
  const outputQueueRef = useRef<string[]>([]);

  const handleOutput = useCallback((data: string) => {
    if (!isTerminalReady || !terminalRef.current) {
      outputQueueRef.current.push(data);
      return;
    }
    terminalRef.current.write(data);
  }, [isTerminalReady]);

  const flushOutputQueue = useCallback(() => {
    const queue = outputQueueRef.current;
    if (queue.length === 0) return;
    queue.forEach(data => terminalRef.current?.write(data));
    outputQueueRef.current = [];
  }, []);

  const handleReady = useCallback(() => {
    // Backend ready event - terminal UI is already ready via handleTerminalReady
    // No need to flush queue again here
  }, []);

  const handleExit = useCallback((code?: number) => {
    setExitCode(code ?? null);
    setIsExited(true);
    onExit?.(code);
  }, [sessionId, onExit]);

  const handleError = useCallback((message: string) => {
    log.error('Terminal error', { sessionId, message });
  }, [sessionId]);

  const {
    session,
    isLoading,
    error,
    write,
    resize,
    sendCtrlC,
    close,
    refresh,
  } = useTerminal({
    sessionId,
    autoConnect: true,
    onOutput: handleOutput,
    onReady: handleReady,
    onExit: handleExit,
    onError: handleError,
  });

  const handleData = useCallback((data: string) => {
    if (!isExited) {
      write(data).catch(err => {
        log.error('Write failed', { sessionId, error: err });
      });
    }
  }, [write, isExited]);

  const handleResize = useCallback((cols: number, rows: number) => {
    const lastSize = lastSentSizeRef.current;
    if (lastSize && lastSize.cols === cols && lastSize.rows === rows) {
      return;
    }
    lastSentSizeRef.current = { cols, rows };

    resize(cols, rows).then(() => {
    }).catch(err => {
      log.error('Resize failed', { sessionId, cols, rows, error: err });
      lastSentSizeRef.current = null;
    });
  }, [resize]);

  const handleTitleChange = useCallback((newTitle: string) => {
    setTitle(newTitle);
    onTitleChange?.(newTitle);
  }, [onTitleChange]);

  const handleTerminalReady = useCallback(() => {
    console.log('[ConnectedTerminal] handleTerminalReady called');
    setIsTerminalReady(true);

    flushOutputQueue();
  }, [flushOutputQueue]);

  // Handle paste with multi-line confirmation.
  const handlePaste = useCallback(async (text: string): Promise<boolean> => {
    if (isExited) {
      return false;
    }

    const lines = text.split('\n');
    const lineCount = lines.length;

    if (lineCount > MULTILINE_PASTE_THRESHOLD) {
      const maxPreviewLines = 10;
      const previewLines = lines.slice(0, maxPreviewLines);
      let preview = previewLines.join('\n');
      if (lineCount > maxPreviewLines) {
        preview += `\n... (${lineCount} lines total)`;
      }

      const confirmed = await confirmWarning(
        'Paste multiple lines',
        `The clipboard contains ${lineCount} lines. Pasting multiple lines in a terminal may execute multiple commands.`,
        {
          confirmText: 'Paste',
          cancelText: 'Cancel',
          preview,
          previewMaxHeight: 150,
        }
      );

      if (!confirmed) {
        return false;
      }
    }

    return true;
  }, [isExited]);

  const handleSendCtrlC = useCallback(() => {
    sendCtrlC().catch(err => {
      log.error('Failed to send Ctrl+C', { sessionId, error: err });
    });
  }, [sendCtrlC, sessionId]);

  const handleClose = useCallback(() => {
    close().catch(err => {
      log.error('Failed to close', { sessionId, error: err });
    });
    onClose?.();
  }, [close, onClose]);

  const handleRetry = useCallback(() => {
    refresh().catch(err => {
      log.error('Retry failed', { sessionId, error: err });
    });
  }, [refresh, sessionId]);

  useEffect(() => {
    if (session) {
      setTitle(session.name);
      if (session.status === 'Exited' || session.status === 'Error') {
        setIsExited(true);
      }
    }
  }, [session]);

  const terminalId = `terminal-${sessionId}`;

  useEffect(() => {
    registerTerminalActions(terminalId, {
      getTerminal: () => terminalRef.current?.getTerminal() || null,
      isReadOnly: isExited,
      write: async (data: string) => {
        if (!isExited) {
          await write(data);
        }
      },
      clear: () => {
        terminalRef.current?.clear();
      },
    });

    return () => {
      unregisterTerminalActions(terminalId);
    };
  }, [terminalId, isExited, write]);

  if (isLoading) {
    return (
      <div className={`bitfun-terminal ${className}`}>
        <div className="bitfun-terminal__loading">
          <div className="bitfun-terminal__loading-spinner" />
          <span className="bitfun-terminal__loading-text">Connecting to terminal...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bitfun-terminal ${className}`}>
        <div className="bitfun-terminal__error">
          <AlertCircle className="bitfun-terminal__error-icon" size={32} />
          <span className="bitfun-terminal__error-message">{error}</span>
          <button 
            className="bitfun-terminal__error-retry"
            onClick={handleRetry}
          >
            <RefreshCw size={14} />
            <span>Retry</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`bitfun-terminal ${className}`}>
      {showToolbar && (
        <div className="bitfun-terminal__toolbar">
          <div className="bitfun-terminal__toolbar-left">
            <TerminalIcon size={14} />
            <span className="bitfun-terminal__toolbar-title">
              {title}
              {session && (
                <span className="shell-type">({session.shellType})</span>
              )}
            </span>
          </div>
          <div className="bitfun-terminal__toolbar-right">
            <button
              className="bitfun-terminal__toolbar-btn"
              onClick={handleSendCtrlC}
              title="Send Ctrl+C"
            >
              <span style={{ fontSize: 10, fontWeight: 'bold' }}>^C</span>
            </button>
            <button
              className="bitfun-terminal__toolbar-btn bitfun-terminal__toolbar-btn--danger"
              onClick={handleClose}
              title="Close terminal"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}

      <Terminal
        ref={terminalRef}
        terminalId={terminalId}
        sessionId={sessionId}
        autoFocus={autoFocus}
        onData={handleData}
        onResize={handleResize}
        onTitleChange={handleTitleChange}
        onReady={handleTerminalReady}
        onPaste={handlePaste}
      />

      {showStatusBar && session && (
        <div className={`bitfun-terminal__statusbar ${
          isExited ? 'bitfun-terminal__statusbar--exited' : ''
        } ${
          error ? 'bitfun-terminal__statusbar--error' : ''
        }`}>
          <div className="bitfun-terminal__statusbar-left">
            <span className="bitfun-terminal__statusbar-item">
              {session.shellType}
            </span>
            <span className="bitfun-terminal__statusbar-item">
              PID: {session.pid || '-'}
            </span>
            <span className="bitfun-terminal__statusbar-item">
              {session.cwd}
            </span>
          </div>
          <div className="bitfun-terminal__statusbar-right">
            <span className="bitfun-terminal__statusbar-item">
              {session.cols}×{session.rows}
            </span>
            {isExited && exitCode !== null && (
              <span className="bitfun-terminal__statusbar-item">
                Exit code: {exitCode}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

ConnectedTerminal.displayName = 'ConnectedTerminal';

export default ConnectedTerminal;
