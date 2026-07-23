"use client";

import { useRef, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Terminal, Map, Activity, Send, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { AgentGraph } from "@/components/agent-graph";
import type { TranscriptEntry } from "@/hooks/use-vorker";

type CenterTab = "console" | "agent-map" | "activity";

export function CenterPanel({ vorker }: { vorker: any }) {
  const { app, setApp, sendCommand, activeAgent, activeRun, transcript, readyTaskCount, booting } = vorker;
  const [tab, setTab] = useState<CenterTab>("console");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript.length]);

  const tabs: { id: CenterTab; label: string; icon: any }[] = [
    { id: "console", label: "Console", icon: Terminal },
    { id: "agent-map", label: "Agent Map", icon: Map },
    { id: "activity", label: "Activity", icon: Activity },
  ];

  return (
    <div className="flex h-full flex-col bg-background font-mono">
      {/* Tab Bar */}
      <div className="flex items-center border-b border-border bg-card">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-2 border-r border-border px-3 py-2 text-sm transition-colors cursor-pointer rounded-none",
              tab === t.id ? "bg-background text-foreground" : "bg-card text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
            aria-label={t.label}
          >
            <t.icon className={cn("h-4 w-4", tab === t.id && "text-primary")} />
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 px-3">
          <StatBadge label="Agents" value={app.agents.length} />
          <StatBadge label="Runs" value={app.runs.length} />
          <StatBadge label="Ready" value={readyTaskCount} />
        </div>
      </div>

      {/* Run context bar */}
      {tab !== "activity" && (
        <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
          <div className="flex items-center gap-3 min-w-0">
            <Badge variant="outline" className="shrink-0 rounded-none font-mono">{activeRun?.name ?? "setup"}</Badge>
            <span className="truncate text-xs text-muted-foreground">{activeRun?.goal ?? "Select a run or create one from the right panel."}</span>
          </div>
          {activeRun && (
            <div className="flex gap-1.5 shrink-0">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-none text-xs"
                onClick={() => void sendCommand({ type: "plan_run", runId: activeRun.id })}
              >
                <Sparkles className="mr-1 h-3 w-3" /> Plan
              </Button>
              <Button
                size="sm"
                className="h-7 rounded-none text-xs"
                onClick={() => void sendCommand({ type: "auto_dispatch_run", runId: activeRun.id })}
              >
                <Play className="mr-1 h-3 w-3" /> Dispatch
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === "console" && <ConsoleTab vorker={vorker} scrollRef={scrollRef} />}
        {tab === "agent-map" && (
          <div className="h-full p-3">
            <AgentGraph
              agents={app.agents}
              runs={app.runs}
              share={app.share}
              activeAgentId={app.activeAgentId}
              activeRunId={app.activeRunId}
              activeTaskId={app.activeTaskId}
              onSelectAgent={(id: string) => setApp((c: any) => ({ ...c, activeAgentId: id }))}
              onSelectRun={(id: string) => setApp((c: any) => ({ ...c, activeRunId: id }))}
              onSelectTask={(id: string) => setApp((c: any) => ({ ...c, activeTaskId: id }))}
            />
          </div>
        )}
        {tab === "activity" && <ActivityTab vorker={vorker} />}
      </div>
    </div>
  );
}

export function MobileConsolePanel({ vorker }: { vorker: any }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { app, setApp } = vorker;

  return (
    <div className="flex h-full flex-col bg-background font-mono">
      <div className="border-b border-border bg-card px-3 py-3">
        <div className="mb-2 text-[10px] uppercase text-muted-foreground">Active Agent</div>
        <div className="grid gap-2">
          {app.agents.length === 0 ? (
            <div className="border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              No agents running
            </div>
          ) : (
            <select
              value={app.activeAgentId ?? ""}
              onChange={(e) => setApp((cur: any) => ({ ...cur, activeAgentId: e.target.value || null }))}
              className="h-10 w-full border border-border bg-background px-3 text-sm text-foreground outline-none"
            >
              {app.agents.map((agent: any) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} {agent.model ? `- ${agent.model}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <ConsoleTab vorker={vorker} scrollRef={scrollRef} compact />
    </div>
  );
}

function ConsoleTab({ vorker, scrollRef, compact = false }: { vorker: any; scrollRef: React.RefObject<HTMLDivElement | null>; compact?: boolean }) {
  const { activeAgent, transcript, sendCommand, booting } = vorker;

  return (
    <div className="flex h-full flex-col bg-[#0b1110]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-[#101716] px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <Terminal className="h-4 w-4 text-primary" />
          <span className="text-sm text-foreground">
            {activeAgent ? `${activeAgent.name}` : "Select an agent"}
          </span>
          {activeAgent && (
            <>
              <Badge variant="outline" className="rounded-none border-primary/30 bg-transparent text-[10px] text-primary">{activeAgent.role || "worker"}</Badge>
              <Badge variant={activeAgent.status === "ready" || activeAgent.status === "running" ? "default" : "outline"} className="rounded-none text-[10px]">
                {activeAgent.status}
              </Badge>
            </>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {!compact ? <span>{activeAgent ? "tty://agent-session" : "tty://detached"}</span> : null}
          {booting && <Badge variant="outline" className="rounded-none animate-pulse">booting</Badge>}
        </div>
      </div>

      {/* Transcript */}
      <ScrollArea className="flex-1" ref={scrollRef}>
        {transcript.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center text-muted-foreground">
            <Terminal className="mb-3 h-8 w-8 opacity-50" />
            <p className="text-sm font-mono">prompt history will stream here once an agent is active</p>
          </div>
        ) : (
          <div className="border-b border-border">
            {transcript.map((entry: TranscriptEntry, i: number) => (
              <article
                key={`${entry.role}-${i}`}
                className={cn(
                  "grid grid-cols-[72px_minmax(0,1fr)] border-t border-border px-4 py-3 text-sm first:border-t-0",
                  entry.role === "user" && "bg-primary/5",
                  entry.role === "agent" && "bg-transparent",
                  entry.role === "system" && "bg-muted/20",
                )}
              >
                <div className="pr-3 text-[10px] uppercase text-muted-foreground">
                  <div className={cn(
                    "inline-flex min-w-11 justify-center border px-2 py-1",
                    entry.role === "user" && "border-primary/40 text-primary",
                    entry.role === "agent" && "border-border text-foreground",
                    entry.role === "system" && "border-border text-muted-foreground",
                  )}>
                    {entry.role}
                  </div>
                </div>
                <ConsoleMarkdown body={entry.body} role={entry.role} />
              </article>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Prompt input */}
      <form
        className="border-t border-border bg-[#101716] p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const text = String(form.get("prompt") ?? "").trim();
          if (!activeAgent || !text) return;
          void sendCommand({ type: "send_prompt", agentId: activeAgent.id, text });
          e.currentTarget.reset();
        }}
      >
        <div className="flex gap-2">
          <Textarea
            name="prompt"
            placeholder={activeAgent ? `Message ${activeAgent.name}...` : "Select an agent first"}
            className="min-h-[92px] resize-none rounded-none border-border bg-[#0b1110] font-mono text-sm leading-6 text-foreground placeholder:text-muted-foreground"
            disabled={!activeAgent}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button type="submit" size="icon" className="h-[92px] w-11 shrink-0 rounded-none" disabled={!activeAgent} aria-label="Send prompt">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function ActivityTab({ vorker }: { vorker: any }) {
  const { app } = vorker;

  return (
    <ScrollArea className="h-full bg-[#0b1110] px-4 py-3 font-mono">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium text-foreground">Recent Events</span>
        <span className="text-xs text-muted-foreground">({app.activity.length})</span>
      </div>
      {app.activity.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <Activity className="mb-3 h-8 w-8 opacity-50" />
          <p className="text-sm">No activity yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {app.activity.map((item: any) => (
            <div key={item.id} className="border border-border bg-background px-3 py-2.5">
              <time className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {new Date(item.timestamp).toLocaleTimeString()}
              </time>
              <div className="mt-1 text-sm text-foreground">{item.summary}</div>
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

function StatBadge({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border bg-background px-2 py-1 text-center">
      <div className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function ConsoleMarkdown({ body, role }: { body: string; role: TranscriptEntry["role"] }) {
  const tone = role === "user" ? "text-primary" : role === "system" ? "text-muted-foreground" : "text-foreground";

  return (
    <div className={cn("min-w-0 text-sm leading-6", tone)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0 whitespace-pre-wrap break-words">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal pl-5">{children}</ol>,
          li: ({ children }) => <li className="mb-1">{children}</li>,
          a: ({ children, href }) => <a className="text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">{children}</a>,
          code: ({ children, className }) => (
            <code className={cn("bg-background px-1 py-0.5 text-[0.95em] text-primary", className)}>{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto border border-border bg-background p-3 text-xs text-foreground [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => <blockquote className="mb-2 border-l border-primary pl-3 text-muted-foreground">{children}</blockquote>,
          h1: ({ children }) => <h1 className="mb-2 text-base font-semibold text-foreground text-balance">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-sm font-semibold text-foreground text-balance">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 text-sm font-medium text-foreground text-balance">{children}</h3>,
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
