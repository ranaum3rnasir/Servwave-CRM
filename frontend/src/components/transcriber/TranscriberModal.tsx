import { useCallback, useRef, useState } from 'react';
import { Mic, UploadCloud, X, Loader2, AlertCircle, FileAudio } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ACCEPTED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/webm',
  'audio/aac',
  'audio/flac',
];

const ACCEPTED_EXTENSIONS = '.mp3,.wav,.m4a,.ogg,.webm,.aac,.flac';
const TRANSCRIBE_API = 'http://localhost:5000/api/transcribe';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface TranscriberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TranscriberModal({ open, onOpenChange }: TranscriberModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [transcription, setTranscription] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setSelectedFile(null);
    setStatus('idle');
    setTranscription('');
    setErrorMsg('');
    setIsDragging(false);
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }

  function acceptFile(file: File | undefined | null) {
    if (!file) return;
    if (
      !ACCEPTED_AUDIO_TYPES.includes(file.type) &&
      !ACCEPTED_EXTENSIONS.split(',').some((ext) =>
        file.name.toLowerCase().endsWith(ext.trim())
      )
    ) {
      setErrorMsg('Unsupported file type. Please upload an audio file (.mp3, .wav, .m4a, .ogg, .webm, etc.)');
      setStatus('error');
      return;
    }
    setSelectedFile(file);
    setStatus('idle');
    setTranscription('');
    setErrorMsg('');
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    acceptFile(e.target.files?.[0]);
    // Reset input value so re-selecting same file re-triggers
    e.target.value = '';
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    acceptFile(e.dataTransfer.files?.[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTranscribe() {
    if (!selectedFile) return;

    setStatus('loading');
    setTranscription('');
    setErrorMsg('');

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const response = await fetch(TRANSCRIBE_API, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error ?? `Server responded with status ${response.status}`);
      }

      setTranscription(data.transcription ?? '');
      setStatus('success');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.';
      setErrorMsg(message);
      setStatus('error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0"
        pad={0}
        gap={0}
      >
        <VisuallyHidden>
          <DialogTitle>Call Recording Transcribing</DialogTitle>
          <DialogDescription>
            Upload an audio file to transcribe it using AI.
          </DialogDescription>
        </VisuallyHidden>

        {/* ── Header ── */}
        <div className="flex items-center gap-3 border-b border-border bg-surface-light px-6 py-4 pr-14">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-on-fill shadow-sm">
            <Mic className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold leading-tight text-text-primary">
              Call Recording Transcribing
            </h2>
            <p className="text-xs text-text-secondary mt-0.5">
              Upload an audio file and get an AI-powered transcription
            </p>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-col gap-5 px-6 py-6">

          {/* Drop Zone */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload audio file drop zone"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-border bg-background-light hover:border-primary/60 hover:bg-primary/5',
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              className="sr-only"
              onChange={handleFileInputChange}
              id="transcriber-file-input"
            />

            {selectedFile ? (
              <>
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FileAudio className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary truncate max-w-[280px]">
                    {selectedFile.name}
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {formatBytes(selectedFile.size)} · Click to change file
                  </p>
                </div>
              </>
            ) : (
              <>
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-background-light text-text-soft shadow-card">
                  <UploadCloud className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    Upload File
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Drag & drop or click to browse
                  </p>
                  <p className="text-[11px] text-text-soft mt-1">
                    Supported: MP3, WAV, M4A, OGG, WEBM, AAC, FLAC
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Action row */}
          <div className="flex items-center justify-between gap-3">
            {selectedFile && (
              <button
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setStatus('idle');
                  setTranscription('');
                  setErrorMsg('');
                }}
                className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-danger transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                Remove file
              </button>
            )}
            <div className="ml-auto">
              <Button
                id="transcriber-submit-btn"
                onClick={handleTranscribe}
                disabled={!selectedFile || status === 'loading'}
                className="min-w-[140px]"
              >
                {status === 'loading' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Transcribing…
                  </>
                ) : (
                  'Transcribe Audio'
                )}
              </Button>
            </div>
          </div>

          {/* Error banner */}
          {status === 'error' && errorMsg && (
            <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Transcription output */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-widest text-text-soft">
                Transcription
              </p>
              {status === 'success' && transcription && (
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(transcription)}
                  className="text-[11px] text-text-secondary underline-offset-2 hover:underline transition-colors"
                >
                  Copy to clipboard
                </button>
              )}
            </div>
            <div
              id="transcriber-output"
              className={cn(
                'min-h-[160px] max-h-[280px] overflow-y-auto rounded-xl border border-border bg-background-light px-4 py-3 text-sm leading-relaxed',
                !transcription && status !== 'loading' ? 'text-text-soft' : 'text-text-primary',
              )}
            >
              {status === 'loading' ? (
                <div className="flex h-full min-h-[136px] flex-col items-center justify-center gap-3 text-text-secondary">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-sm">Transcribing audio…</p>
                </div>
              ) : transcription ? (
                <p className="whitespace-pre-wrap">{transcription}</p>
              ) : (
                <p className="italic">
                  Transcription results will appear here after processing.
                </p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
