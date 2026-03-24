import type { FileChange } from "./code-intelligence.js";
export type FileValidationResult = {
    ok: boolean;
    issues: string[];
    validatedFiles: string[];
};
export declare function validateFileChanges(changes: FileChange[]): FileValidationResult;
export declare function materializePatchChanges(root: string, patch: string): Promise<{
    changes: FileChange[];
    validation: FileValidationResult;
}>;
