import { Bot, User as UserIcon, FileText, Copy, Check, Download } from "lucide-react";
import React, { useState } from "react";
import SourceCard from "./SourceCard";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** GFM autolink inside markdown link text can produce <a><a/></a>; React forbids nested anchors. */
function containsNestedAnchor(nodes: React.ReactNode): boolean {
  return React.Children.toArray(nodes).some((child) => {
    if (!React.isValidElement(child)) return false;
    if (typeof child.type === "string" && child.type === "a") return true;
    const props = child.props as { children?: React.ReactNode };
    if (props.children != null) return containsNestedAnchor(props.children);
    return false;
  });
}

const markdownComponents: Components = {
  a: ({ href, children, ...rest }) => {
    if (containsNestedAnchor(children)) {
      return (
        <span className="font-medium text-primary underline underline-offset-2">
          {children}
        </span>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
};

export interface ChatSource {
  sourceNumber: number;
  documentName: string;
  page: number;
  source: string;
  category?: string;
  snippet?: string;
}

export interface ChatClassification {
  categories: string[];
  primaryCategory: string;
  confidence: string;
}

export interface ChatMessageType {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  classification?: ChatClassification;
  suggestedQuestions?: string[];
}

interface ChatMessageProps {
  message: ChatMessageType;
  isScrolling?: boolean;
  onSuggestedClick?: (question: string) => void;
}

export default function ChatMessage({ message, onSuggestedClick }: ChatMessageProps) {
  const isAI = message.role === "assistant";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    toast.success("Content copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => {
    const blob = new Blob([message.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Clinical_Summary_${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Clinical summary exported as text");
  };

  return (
    <div
      className={`flex gap-4 p-6 w-full ${isAI ? "" : "flex-row-reverse"
        } animate-pop-in`}
    >
      <div
        className={`w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0 z-10 ${isAI
          ? "gradient-primary shadow-glow ring-4 ring-primary/10"
          : "bg-muted border border-white/10"
          }`}
      >
        {isAI ? (
          <Bot className="w-5 h-5 text-primary-foreground" />
        ) : (
          <UserIcon className="w-5 h-5 text-muted-foreground" />
        )}
      </div>

      <div className={`flex flex-col gap-2 max-w-[85%] ${!isAI ? "items-end" : ""}`}>
        <div className="flex items-center gap-2 px-1">
          <span className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground/60">
            {isAI ? "Verified MedRep AI" : "Professional Inquiry"}
          </span>
          {isAI && (
            <div className="flex gap-1">
              <div className="w-1 h-1 rounded-full bg-primary/40" />
              <div className="w-1 h-1 rounded-full bg-primary/20" />
            </div>
          )}
        </div>

        <div
          className={`relative group px-5 py-4 rounded-2xl leading-relaxed text-[15px] ${isAI
            ? "bg-card border border-white/5 text-foreground shadow-premium ring-1 ring-white/5"
            : "bg-primary text-primary-foreground font-medium"
            }`}
        >
          {isAI ? (
            <div className="prose prose-invert prose-emerald max-w-none prose-p:leading-relaxed prose-headings:mb-4 prose-headings:mt-6 first:prose-headings:mt-0 prose-table:border prose-table:border-white/10 prose-th:bg-white/5 prose-th:px-4 prose-th:py-2 prose-td:px-4 prose-td:py-2 prose-td:border-t prose-td:border-white/5">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            message.content
          )}

          {isAI && (
            <div className="absolute -right-12 top-0 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="p-2 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-primary transition-colors"
                title="Copy to clipboard"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
              <button
                onClick={handleExport}
                className="p-2 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-emerald-400 transition-colors"
                title="Export as Text"
              >
                <Download className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Suggested Questions Chips */}
        {isAI && message.suggestedQuestions && message.suggestedQuestions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 animate-pop-in animate-stagger-1">
            {message.suggestedQuestions.map((question, i) => (
              <button
                key={i}
                onClick={() => onSuggestedClick?.(question)}
                className="text-[12px] px-4 py-2 rounded-full border border-primary/20 bg-primary/5 hover:bg-primary/10 hover:border-primary/40 text-primary transition-all font-medium text-left"
              >
                {question}
              </button>
            ))}
          </div>
        )}

        {/* Display sources if available */}
        {isAI && message.sources && message.sources.length > 0 && (
          <div className="mt-6 w-full space-y-3 animate-pop-in animate-stagger-2 text-left">
            <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground/50 uppercase tracking-tighter">
              <FileText className="w-3 h-3" />
              <span>Evidence Sources ({message.sources.length})</span>
              <div className="flex-1 h-px bg-white/5" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {message.sources.map((source, idx) => (
                <SourceCard key={idx} source={source} />
              ))}
            </div>
          </div>
        )}

        {/* Display classification info */}
        {isAI && message.classification && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/40 animate-pop-in animate-stagger-3">
            <span className="font-bold uppercase tracking-widest text-[9px]">Clinical Context:</span>
            {message.classification.categories.map((cat) => (
              <span
                key={cat}
                className="bg-muted/50 px-2 py-0.5 rounded uppercase font-bold"
              >
                {cat}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
