import { basename } from "path";

export interface FileStatus {
  path: string;
  filename: string;
  status: "pending" | "chunking" | "embedding" | "done" | "error";
  chunks?: number;
  error?: string;
}

export interface IngestState {
  phase: "discovering" | "processing" | "done" | "error";
  totalFiles: number;
  processedFiles: number;
  currentFile?: FileStatus;
  recentFiles: FileStatus[];
  errors: FileStatus[];
  startTime: number;
  endTime?: number;
  checkpointInProgress?: boolean;
  checkpointMessage?: string;
  lastCheckpointAt?: number;
}

export function createInitialState(): IngestState {
  return {
    phase: "discovering",
    totalFiles: 0,
    processedFiles: 0,
    recentFiles: [],
    errors: [],
    startTime: Date.now(),
  };
}

function fileLabel(file: FileStatus): string {
  return file.filename || basename(file.path);
}

function renderStatusLine(state: IngestState, file: FileStatus): string {
  const total = state.totalFiles || "?";
  const isProcessed = file.status === "done" || file.status === "error";
  const nextFileIndex = state.processedFiles + 1;
  const index = isProcessed
    ? state.processedFiles
    : Math.min(nextFileIndex, state.totalFiles || nextFileIndex);
  const chunks = typeof file.chunks === "number" ? ` (${file.chunks} chunks)` : "";
  const error = file.error ? `: ${file.error}` : "";
  return `[${index}/${total}] ${file.status} ${fileLabel(file)}${chunks}${error}`;
}

export function renderIngestProgress(initialState: IngestState) {
  let state = { ...initialState };
  let lastCurrentKey: string | undefined;
  let lastCheckpointAt: number | undefined;

  const writeLine = (line: string) => process.stdout.write(`${line}\n`);

  if (state.totalFiles > 0) {
    writeLine(`Processing ${state.totalFiles} file(s)...`);
  }

  return {
    update(newState: Partial<IngestState>) {
      state = { ...state, ...newState };

      if (newState.currentFile) {
        const file = newState.currentFile;
        const key = [
          file.path,
          file.status,
          file.chunks ?? "",
          file.error ?? "",
          state.processedFiles,
        ].join(":");
        if (key !== lastCurrentKey) {
          writeLine(renderStatusLine(state, file));
          lastCurrentKey = key;
        }
      }

      if (
        state.checkpointInProgress &&
        state.checkpointMessage &&
        state.lastCheckpointAt !== lastCheckpointAt
      ) {
        writeLine(state.checkpointMessage);
        lastCheckpointAt = state.lastCheckpointAt;
      }

      if (newState.phase === "done") {
        const failed = state.errors.length;
        const succeeded = state.processedFiles - failed;
        writeLine(`Done: ${succeeded} succeeded, ${failed} failed`);
      }
    },

    isCancelled() {
      return false;
    },

    cleanup() {
      // Line-based progress has no terminal state to clear.
    },

    getState() {
      return state;
    },
  };
}
