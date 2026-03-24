import ts from "typescript";
export type CodeSymbolKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "method" | "property" | "namespace";
export type CodeSymbolMatch = {
    name: string;
    kind: CodeSymbolKind;
    exported: boolean;
    filePath: string;
    line: number;
    column: number;
    preview: string;
    containerName?: string;
};
export type CodeReference = {
    filePath: string;
    line: number;
    column: number;
    preview: string;
    isDefinition: boolean;
};
export type CodeExport = {
    name: string;
    kind: string;
    line: number;
    column: number;
    preview: string;
    moduleSpecifier?: string;
    isTypeOnly?: boolean;
    isDefault?: boolean;
};
export type CodeImport = {
    moduleSpecifier: string;
    kind: "default" | "named" | "namespace" | "side_effect" | "require";
    imported?: string;
    localName?: string;
    line: number;
    column: number;
    preview: string;
    isTypeOnly?: boolean;
};
export type AstEditAction = "rename_symbol" | "add_import" | "remove_import" | "replace_symbol_declaration";
export type AstEditRequest = {
    action: AstEditAction;
    path: string;
    symbol?: string;
    symbolKind?: string;
    newName?: string;
    moduleSpecifier?: string;
    defaultImport?: string;
    namespaceImport?: string;
    namedImports?: string[];
    typeOnly?: boolean;
    bindingName?: string;
    replacement?: string;
};
export type FileChange = {
    filePath: string;
    before: string;
    after: string;
};
export type AstEditResult = {
    summary: string;
    changes: FileChange[];
};
export type CodeWorkspace = {
    root: string;
    fileNames: string[];
    skippedLargeFiles: number;
    languageService: ts.LanguageService;
    getProgram: () => ts.Program | undefined;
    getSourceFile: (filePath: string) => ts.SourceFile | undefined;
    getText: (filePath: string) => string | undefined;
    dispose: () => void;
};
export declare function createCodeWorkspace(root: string): Promise<CodeWorkspace>;
export declare function findSymbols(workspace: CodeWorkspace, options: {
    query: string;
    scopePath?: string;
    exact?: boolean;
    kind?: string;
    limit?: number;
}): CodeSymbolMatch[];
export declare function findReferences(workspace: CodeWorkspace, options: {
    symbol: string;
    scopePath?: string;
    kind?: string;
    includeDeclaration?: boolean;
    limit?: number;
}): {
    declaration: CodeSymbolMatch;
    references: CodeReference[];
} | null;
export declare function listExports(workspace: CodeWorkspace, filePath: string): CodeExport[];
export declare function listImports(workspace: CodeWorkspace, filePath: string): CodeImport[];
export declare function performAstEdit(workspace: CodeWorkspace, request: AstEditRequest): AstEditResult;
