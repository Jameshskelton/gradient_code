import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
const SUPPORTED_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".d.ts",
]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".gradient-code", "dist", "build", "coverage"]);
const MAX_SOURCE_FILES = 1_200;
const MAX_SOURCE_FILE_SIZE = 1024 * 1024;
function isSupportedSourceFile(filePath) {
    const lowerPath = filePath.toLowerCase();
    if (lowerPath.endsWith(".d.ts")) {
        return true;
    }
    return SUPPORTED_EXTENSIONS.has(path.extname(lowerPath));
}
function isWithinRoot(root, targetPath) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}
function lineAndColumn(sourceFile, position) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
    return { line: line + 1, column: character + 1 };
}
function previewForPosition(sourceFile, position) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(position);
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
    const lineCount = sourceFile.getLineStarts().length;
    const nextLineStart = line + 1 < lineCount
        ? sourceFile.getPositionOfLineAndCharacter(line + 1, 0)
        : sourceFile.text.length;
    return sourceFile.text.slice(lineStart, nextLineStart).trim();
}
function hasModifier(node, kind) {
    if (!ts.canHaveModifiers(node)) {
        return false;
    }
    return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}
function isExportedNode(node) {
    if (hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
        return true;
    }
    if (ts.isVariableDeclaration(node)) {
        const statement = node.parent?.parent;
        return statement ? isExportedNode(statement) : false;
    }
    return false;
}
function nodeNameText(name) {
    if (!name) {
        return null;
    }
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    if (ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression)) {
        return name.expression.text;
    }
    return null;
}
function declarationKindFromNode(node) {
    if (ts.isFunctionDeclaration(node)) {
        return "function";
    }
    if (ts.isClassDeclaration(node)) {
        return "class";
    }
    if (ts.isInterfaceDeclaration(node)) {
        return "interface";
    }
    if (ts.isTypeAliasDeclaration(node)) {
        return "type";
    }
    if (ts.isEnumDeclaration(node)) {
        return "enum";
    }
    if (ts.isVariableDeclaration(node)) {
        return "variable";
    }
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        return "method";
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
        return "property";
    }
    if (ts.isModuleDeclaration(node)) {
        return "namespace";
    }
    return null;
}
function containerNameForNode(node) {
    let current = node.parent;
    while (current) {
        if ((ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current) || ts.isModuleDeclaration(current)) && current.name) {
            const name = nodeNameText(current.name);
            if (name) {
                return name;
            }
        }
        current = current.parent;
    }
    return undefined;
}
function collectDeclarations(sourceFile) {
    const results = [];
    function push(node, nameNode) {
        const kind = declarationKindFromNode(node);
        if (!kind) {
            return;
        }
        const name = nodeNameText(nameNode);
        if (!name) {
            return;
        }
        const { line, column } = lineAndColumn(sourceFile, nameNode.getStart(sourceFile));
        results.push({
            name,
            kind,
            exported: isExportedNode(node),
            filePath: sourceFile.fileName,
            line,
            column,
            preview: previewForPosition(sourceFile, node.getStart(sourceFile)),
            containerName: containerNameForNode(node),
            sourceFile,
            nameNode,
            targetNode: node,
        });
    }
    function visit(node) {
        if (ts.isFunctionDeclaration(node) && node.name) {
            push(node, node.name);
        }
        else if (ts.isClassDeclaration(node) && node.name) {
            push(node, node.name);
        }
        else if (ts.isInterfaceDeclaration(node)) {
            push(node, node.name);
        }
        else if (ts.isTypeAliasDeclaration(node)) {
            push(node, node.name);
        }
        else if (ts.isEnumDeclaration(node)) {
            push(node, node.name);
        }
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            push(node, node.name);
        }
        else if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name) {
            push(node, node.name);
        }
        else if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.name) {
            push(node, node.name);
        }
        else if (ts.isModuleDeclaration(node)) {
            push(node, node.name);
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return results;
}
function normalizeFilterKind(kind) {
    if (!kind) {
        return null;
    }
    const normalized = kind.trim().toLowerCase();
    const kinds = ["function", "class", "interface", "type", "enum", "variable", "method", "property", "namespace"];
    return kinds.includes(normalized) ? normalized : null;
}
async function collectSourceFiles(root) {
    const results = [];
    let skippedLargeFiles = 0;
    async function walk(currentPath) {
        if (results.length >= MAX_SOURCE_FILES) {
            return;
        }
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= MAX_SOURCE_FILES) {
                return;
            }
            if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
                continue;
            }
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (!entry.isFile() || !isSupportedSourceFile(fullPath)) {
                continue;
            }
            const stats = await fs.stat(fullPath);
            if (stats.size > MAX_SOURCE_FILE_SIZE) {
                skippedLargeFiles += 1;
                continue;
            }
            results.push(path.resolve(fullPath));
        }
    }
    await walk(root);
    results.sort((left, right) => left.localeCompare(right));
    return { fileNames: results, skippedLargeFiles };
}
async function resolveWorkspaceFiles(root) {
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    const baseOptions = {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
    };
    if (configPath) {
        const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
        if (!readResult.error) {
            const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, path.dirname(configPath), baseOptions, configPath);
            const filtered = parsed.fileNames
                .map((fileName) => path.resolve(fileName))
                .filter((fileName) => isWithinRoot(root, fileName) && isSupportedSourceFile(fileName));
            if (filtered.length > 0) {
                return {
                    fileNames: filtered.slice(0, MAX_SOURCE_FILES),
                    compilerOptions: {
                        ...parsed.options,
                        ...baseOptions,
                    },
                    skippedLargeFiles: Math.max(0, filtered.length - MAX_SOURCE_FILES),
                };
            }
        }
    }
    const collected = await collectSourceFiles(root);
    return {
        fileNames: collected.fileNames,
        compilerOptions: baseOptions,
        skippedLargeFiles: collected.skippedLargeFiles,
    };
}
export async function createCodeWorkspace(root) {
    const resolvedRoot = path.resolve(root);
    const { fileNames, compilerOptions, skippedLargeFiles } = await resolveWorkspaceFiles(resolvedRoot);
    const fileContents = new Map();
    for (const fileName of fileNames) {
        fileContents.set(fileName, await fs.readFile(fileName, "utf8"));
    }
    const host = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => fileNames,
        getScriptVersion: () => "0",
        getScriptSnapshot: (fileName) => {
            const resolved = path.resolve(fileName);
            const text = fileContents.get(resolved) ?? ts.sys.readFile(resolved);
            return typeof text === "string" ? ts.ScriptSnapshot.fromString(text) : undefined;
        },
        getCurrentDirectory: () => resolvedRoot,
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        readFile: ts.sys.readFile,
        fileExists: ts.sys.fileExists,
        directoryExists: ts.sys.directoryExists?.bind(ts.sys),
        getDirectories: ts.sys.getDirectories?.bind(ts.sys),
        readDirectory: ts.sys.readDirectory,
        realpath: ts.sys.realpath?.bind(ts.sys),
        getNewLine: () => ts.sys.newLine,
    };
    const languageService = ts.createLanguageService(host);
    return {
        root: resolvedRoot,
        fileNames,
        skippedLargeFiles,
        languageService,
        getProgram: () => languageService.getProgram(),
        getSourceFile: (filePath) => {
            const resolved = path.resolve(filePath);
            const programSourceFile = languageService.getProgram()?.getSourceFile(resolved);
            if (programSourceFile) {
                return programSourceFile;
            }
            const text = fileContents.get(resolved) ?? ts.sys.readFile(resolved);
            return typeof text === "string"
                ? ts.createSourceFile(resolved, text, ts.ScriptTarget.Latest, true)
                : undefined;
        },
        getText: (filePath) => {
            const resolved = path.resolve(filePath);
            return fileContents.get(resolved) ?? ts.sys.readFile(resolved);
        },
        dispose: () => {
            languageService.dispose();
        },
    };
}
function pathMatchesScope(filePath, scopePath) {
    if (!scopePath) {
        return true;
    }
    const resolvedScope = path.resolve(scopePath);
    const resolvedFile = path.resolve(filePath);
    if (resolvedFile === resolvedScope) {
        return true;
    }
    return resolvedFile.startsWith(`${resolvedScope}${path.sep}`);
}
function allDeclarations(workspace) {
    const results = [];
    const program = workspace.getProgram();
    if (!program) {
        return results;
    }
    for (const fileName of workspace.fileNames) {
        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) {
            continue;
        }
        results.push(...collectDeclarations(sourceFile));
    }
    return results;
}
export function findSymbols(workspace, options) {
    const normalizedQuery = options.query.trim();
    const normalizedKind = normalizeFilterKind(options.kind);
    const exact = options.exact ?? false;
    const limit = options.limit ?? 20;
    const matches = allDeclarations(workspace).filter((declaration) => {
        if (normalizedKind && declaration.kind !== normalizedKind) {
            return false;
        }
        if (!pathMatchesScope(declaration.filePath, options.scopePath)) {
            return false;
        }
        return exact
            ? declaration.name === normalizedQuery
            : declaration.name.toLowerCase().includes(normalizedQuery.toLowerCase());
    });
    return matches.slice(0, limit);
}
function bestDeclarationMatch(workspace, options) {
    const normalizedKind = normalizeFilterKind(options.kind);
    const matches = allDeclarations(workspace).filter((declaration) => {
        if (declaration.name !== options.symbol) {
            return false;
        }
        if (normalizedKind && declaration.kind !== normalizedKind) {
            return false;
        }
        return pathMatchesScope(declaration.filePath, options.scopePath);
    });
    if (matches.length === 0) {
        return null;
    }
    matches.sort((left, right) => {
        if (left.exported !== right.exported) {
            return left.exported ? -1 : 1;
        }
        if (left.kind !== right.kind) {
            return left.kind.localeCompare(right.kind);
        }
        return left.filePath.localeCompare(right.filePath);
    });
    return matches[0];
}
export function findReferences(workspace, options) {
    const declaration = bestDeclarationMatch(workspace, options);
    if (!declaration) {
        return null;
    }
    const limit = options.limit ?? 50;
    const groups = workspace.languageService.findReferences(declaration.filePath, declaration.nameNode.getStart(declaration.sourceFile)) ?? [];
    const references = [];
    for (const group of groups) {
        for (const entry of group.references) {
            if (!options.includeDeclaration && entry.isDefinition) {
                continue;
            }
            if (!pathMatchesScope(entry.fileName, options.scopePath)) {
                continue;
            }
            const sourceFile = workspace.getSourceFile(entry.fileName);
            if (!sourceFile) {
                continue;
            }
            const { line, column } = lineAndColumn(sourceFile, entry.textSpan.start);
            references.push({
                filePath: entry.fileName,
                line,
                column,
                preview: previewForPosition(sourceFile, entry.textSpan.start),
                isDefinition: entry.isDefinition ?? false,
            });
            if (references.length >= limit) {
                return { declaration, references };
            }
        }
    }
    return { declaration, references };
}
export function listExports(workspace, filePath) {
    const sourceFile = workspace.getSourceFile(filePath);
    if (!sourceFile) {
        return [];
    }
    const results = [];
    for (const statement of sourceFile.statements) {
        if ((ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
            statement.name &&
            isExportedNode(statement)) {
            const { line, column } = lineAndColumn(sourceFile, statement.name.getStart(sourceFile));
            results.push({
                name: statement.name.text,
                kind: declarationKindFromNode(statement) ?? "symbol",
                line,
                column,
                preview: previewForPosition(sourceFile, statement.getStart(sourceFile)),
                isDefault: hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
            });
            continue;
        }
        if (ts.isVariableStatement(statement) && isExportedNode(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }
                const { line, column } = lineAndColumn(sourceFile, declaration.name.getStart(sourceFile));
                results.push({
                    name: declaration.name.text,
                    kind: "variable",
                    line,
                    column,
                    preview: previewForPosition(sourceFile, declaration.getStart(sourceFile)),
                });
            }
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            const { line, column } = lineAndColumn(sourceFile, statement.getStart(sourceFile));
            results.push({
                name: statement.isExportEquals ? "export =" : "default",
                kind: "assignment",
                line,
                column,
                preview: previewForPosition(sourceFile, statement.getStart(sourceFile)),
                isDefault: !statement.isExportEquals,
            });
            continue;
        }
        if (ts.isExportDeclaration(statement)) {
            const moduleSpecifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : undefined;
            if (!statement.exportClause) {
                const { line, column } = lineAndColumn(sourceFile, statement.getStart(sourceFile));
                results.push({
                    name: "*",
                    kind: "re_export_all",
                    line,
                    column,
                    preview: previewForPosition(sourceFile, statement.getStart(sourceFile)),
                    moduleSpecifier,
                    isTypeOnly: statement.isTypeOnly,
                });
                continue;
            }
            if (ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    const nameNode = element.name;
                    const { line, column } = lineAndColumn(sourceFile, nameNode.getStart(sourceFile));
                    results.push({
                        name: element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text,
                        kind: "named_export",
                        line,
                        column,
                        preview: previewForPosition(sourceFile, element.getStart(sourceFile)),
                        moduleSpecifier,
                        isTypeOnly: statement.isTypeOnly || element.isTypeOnly,
                    });
                }
            }
        }
    }
    return results;
}
export function listImports(workspace, filePath) {
    const sourceFile = workspace.getSourceFile(filePath);
    if (!sourceFile) {
        return [];
    }
    const results = [];
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const moduleSpecifier = statement.moduleSpecifier.text;
            const preview = previewForPosition(sourceFile, statement.getStart(sourceFile));
            const { line, column } = lineAndColumn(sourceFile, statement.getStart(sourceFile));
            const clause = statement.importClause;
            if (!clause) {
                results.push({
                    moduleSpecifier,
                    kind: "side_effect",
                    line,
                    column,
                    preview,
                });
                continue;
            }
            if (clause.name) {
                results.push({
                    moduleSpecifier,
                    kind: "default",
                    imported: "default",
                    localName: clause.name.text,
                    line,
                    column,
                    preview,
                    isTypeOnly: clause.isTypeOnly,
                });
            }
            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                results.push({
                    moduleSpecifier,
                    kind: "namespace",
                    imported: "*",
                    localName: clause.namedBindings.name.text,
                    line,
                    column,
                    preview,
                    isTypeOnly: clause.isTypeOnly,
                });
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const element of clause.namedBindings.elements) {
                    results.push({
                        moduleSpecifier,
                        kind: "named",
                        imported: element.propertyName?.text ?? element.name.text,
                        localName: element.name.text,
                        line,
                        column,
                        preview,
                        isTypeOnly: clause.isTypeOnly || element.isTypeOnly,
                    });
                }
            }
            continue;
        }
        if (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1 &&
            ts.isVariableDeclaration(statement.declarationList.declarations[0]) &&
            ts.isIdentifier(statement.declarationList.declarations[0].name)) {
            const declaration = statement.declarationList.declarations[0];
            const initializer = declaration.initializer;
            if (initializer &&
                ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                initializer.expression.text === "require" &&
                initializer.arguments.length === 1 &&
                ts.isStringLiteral(initializer.arguments[0])) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }
                const { line, column } = lineAndColumn(sourceFile, declaration.getStart(sourceFile));
                results.push({
                    moduleSpecifier: initializer.arguments[0].text,
                    kind: "require",
                    localName: declaration.name.text,
                    line,
                    column,
                    preview: previewForPosition(sourceFile, declaration.getStart(sourceFile)),
                });
            }
        }
    }
    return results;
}
function applyTextEdits(content, edits) {
    const sorted = [...edits].sort((left, right) => right.start - left.start);
    let nextContent = content;
    for (const edit of sorted) {
        nextContent = `${nextContent.slice(0, edit.start)}${edit.newText}${nextContent.slice(edit.end)}`;
    }
    return nextContent;
}
function detectNewline(content) {
    return content.includes("\r\n") ? "\r\n" : "\n";
}
function detectQuote(content) {
    const singleCount = (content.match(/'/g) ?? []).length;
    const doubleCount = (content.match(/"/g) ?? []).length;
    return singleCount >= doubleCount ? "'" : '"';
}
function parseNamedImports(values) {
    const parsed = values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
        const match = value.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        if (match) {
            return { name: match[1], alias: match[2] };
        }
        return { name: value };
    });
    const unique = new Map();
    for (const entry of parsed) {
        unique.set(`${entry.name}:${entry.alias ?? ""}`, entry);
    }
    return [...unique.values()].sort((left, right) => {
        const leftKey = left.alias ? `${left.name} as ${left.alias}` : left.name;
        const rightKey = right.alias ? `${right.name} as ${right.alias}` : right.name;
        return leftKey.localeCompare(rightKey);
    });
}
function buildImportStatement(moduleSpecifier, bindings, options) {
    const moduleText = `${options.quote}${moduleSpecifier}${options.quote}`;
    const prefix = bindings.typeOnly ? "import type " : "import ";
    if (!bindings.defaultImport && !bindings.namespaceImport && bindings.namedImports.length === 0) {
        return `import ${moduleText};${options.newline}`;
    }
    if (bindings.namespaceImport) {
        const clause = bindings.defaultImport
            ? `${bindings.defaultImport}, * as ${bindings.namespaceImport}`
            : `* as ${bindings.namespaceImport}`;
        return `${prefix}${clause} from ${moduleText};${options.newline}`;
    }
    const namedImports = bindings.namedImports
        .map((entry) => (entry.alias ? `${entry.name} as ${entry.alias}` : entry.name))
        .join(", ");
    const parts = [];
    if (bindings.defaultImport) {
        parts.push(bindings.defaultImport);
    }
    if (namedImports) {
        parts.push(`{ ${namedImports} }`);
    }
    return `${prefix}${parts.join(", ")} from ${moduleText};${options.newline}`;
}
function readImportBindings(declaration) {
    const clause = declaration.importClause;
    const bindings = {
        defaultImport: clause?.name?.text,
        namespaceImport: undefined,
        namedImports: [],
        typeOnly: clause?.isTypeOnly ?? false,
    };
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.namespaceImport = clause.namedBindings.name.text;
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        bindings.namedImports = clause.namedBindings.elements.map((element) => ({
            name: element.propertyName?.text ?? element.name.text,
            alias: element.propertyName ? element.name.text : undefined,
        }));
    }
    return bindings;
}
function mergeImportBindings(existing, requested) {
    if (existing.typeOnly !== requested.typeOnly) {
        return null;
    }
    if (existing.namespaceImport && requested.namedImports.length > 0) {
        return null;
    }
    if (requested.namespaceImport && existing.namedImports.length > 0) {
        return null;
    }
    return {
        defaultImport: requested.defaultImport ?? existing.defaultImport,
        namespaceImport: requested.namespaceImport ?? existing.namespaceImport,
        namedImports: parseNamedImports([
            ...existing.namedImports.map((entry) => (entry.alias ? `${entry.name} as ${entry.alias}` : entry.name)),
            ...requested.namedImports.map((entry) => (entry.alias ? `${entry.name} as ${entry.alias}` : entry.name)),
        ]),
        typeOnly: existing.typeOnly,
    };
}
function buildRenameEdits(workspace, declaration, newName) {
    const renameLocations = workspace.languageService.findRenameLocations(declaration.filePath, declaration.nameNode.getStart(declaration.sourceFile), false, false, true) ?? [];
    const grouped = new Map();
    for (const location of renameLocations) {
        if (!isWithinRoot(workspace.root, location.fileName)) {
            continue;
        }
        const nextText = `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}`;
        const edits = grouped.get(location.fileName) ?? [];
        edits.push({
            start: location.textSpan.start,
            end: location.textSpan.start + location.textSpan.length,
            newText: nextText,
        });
        grouped.set(location.fileName, edits);
    }
    const changes = [];
    for (const [filePath, edits] of grouped) {
        const before = workspace.getText(filePath);
        if (typeof before !== "string") {
            continue;
        }
        const after = applyTextEdits(before, edits);
        if (after !== before) {
            changes.push({ filePath, before, after });
        }
    }
    return changes;
}
function importModuleDeclarations(sourceFile, moduleSpecifier) {
    return sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === moduleSpecifier);
}
function importInsertPosition(sourceFile) {
    const importStatements = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement));
    if (importStatements.length > 0) {
        return importStatements[importStatements.length - 1].getEnd();
    }
    return 0;
}
function buildAddImportChange(workspace, filePath, request) {
    const sourceFile = workspace.getSourceFile(filePath);
    const before = workspace.getText(filePath);
    if (!sourceFile || typeof before !== "string") {
        throw new Error(`Unable to read source file: ${filePath}`);
    }
    const moduleSpecifier = request.moduleSpecifier?.trim();
    if (!moduleSpecifier) {
        throw new Error("Missing module_specifier for add_import");
    }
    const namedImports = parseNamedImports(request.namedImports ?? []);
    const requestedBindings = {
        defaultImport: request.defaultImport?.trim() || undefined,
        namespaceImport: request.namespaceImport?.trim() || undefined,
        namedImports,
        typeOnly: request.typeOnly ?? false,
    };
    if (!requestedBindings.defaultImport && !requestedBindings.namespaceImport && requestedBindings.namedImports.length === 0) {
        throw new Error("add_import requires default_import, namespace_import, or named_imports");
    }
    const newline = detectNewline(before);
    const quote = detectQuote(before);
    const declarations = importModuleDeclarations(sourceFile, moduleSpecifier);
    for (const declaration of declarations) {
        const existingBindings = readImportBindings(declaration);
        const mergedBindings = mergeImportBindings(existingBindings, requestedBindings);
        if (!mergedBindings) {
            continue;
        }
        const replacement = buildImportStatement(moduleSpecifier, mergedBindings, { newline, quote });
        const after = applyTextEdits(before, [{
                start: declaration.getStart(sourceFile),
                end: declaration.getEnd(),
                newText: replacement.trimEnd(),
            }]);
        if (after === before) {
            return [];
        }
        return [{ filePath, before, after }];
    }
    const statement = buildImportStatement(moduleSpecifier, requestedBindings, { newline, quote });
    const insertAt = importInsertPosition(sourceFile);
    const prefix = insertAt === 0 ? "" : newline;
    const after = `${before.slice(0, insertAt)}${prefix}${statement}${before.slice(insertAt)}`;
    return after === before ? [] : [{ filePath, before, after }];
}
function buildRemoveImportChange(workspace, filePath, request) {
    const sourceFile = workspace.getSourceFile(filePath);
    const before = workspace.getText(filePath);
    if (!sourceFile || typeof before !== "string") {
        throw new Error(`Unable to read source file: ${filePath}`);
    }
    const moduleSpecifier = request.moduleSpecifier?.trim();
    if (!moduleSpecifier) {
        throw new Error("Missing module_specifier for remove_import");
    }
    const bindingName = request.bindingName?.trim();
    const newline = detectNewline(before);
    const quote = detectQuote(before);
    const declarations = importModuleDeclarations(sourceFile, moduleSpecifier);
    if (declarations.length === 0) {
        throw new Error(`Import not found for module ${moduleSpecifier}`);
    }
    const edits = [];
    let changed = false;
    for (const declaration of declarations) {
        if (!bindingName) {
            edits.push({
                start: declaration.getFullStart(),
                end: declaration.getEnd(),
                newText: "",
            });
            changed = true;
            continue;
        }
        const bindings = readImportBindings(declaration);
        const nextBindings = {
            defaultImport: bindings.defaultImport === bindingName ? undefined : bindings.defaultImport,
            namespaceImport: bindings.namespaceImport === bindingName ? undefined : bindings.namespaceImport,
            namedImports: bindings.namedImports.filter((entry) => entry.name !== bindingName && entry.alias !== bindingName),
            typeOnly: bindings.typeOnly,
        };
        const removedSomething = nextBindings.defaultImport !== bindings.defaultImport ||
            nextBindings.namespaceImport !== bindings.namespaceImport ||
            nextBindings.namedImports.length !== bindings.namedImports.length;
        if (!removedSomething) {
            continue;
        }
        changed = true;
        const replacement = nextBindings.defaultImport || nextBindings.namespaceImport || nextBindings.namedImports.length > 0
            ? buildImportStatement(moduleSpecifier, nextBindings, { newline, quote }).trimEnd()
            : "";
        edits.push({
            start: replacement ? declaration.getStart(sourceFile) : declaration.getFullStart(),
            end: declaration.getEnd(),
            newText: replacement,
        });
    }
    if (!changed) {
        throw new Error(`Binding ${bindingName} not found in import from ${moduleSpecifier}`);
    }
    const after = applyTextEdits(before, edits);
    return after === before ? [] : [{ filePath, before, after }];
}
function buildReplaceSymbolChange(workspace, filePath, request) {
    const before = workspace.getText(filePath);
    if (typeof before !== "string") {
        throw new Error(`Unable to read source file: ${filePath}`);
    }
    const symbol = request.symbol?.trim();
    const replacement = request.replacement;
    if (!symbol || typeof replacement !== "string") {
        throw new Error("replace_symbol_declaration requires symbol and replacement");
    }
    const declaration = bestDeclarationMatch(workspace, {
        symbol,
        scopePath: filePath,
        kind: request.symbolKind,
    });
    if (!declaration) {
        throw new Error(`Symbol not found: ${symbol}`);
    }
    const after = applyTextEdits(before, [{
            start: declaration.targetNode.getStart(declaration.sourceFile),
            end: declaration.targetNode.getEnd(),
            newText: replacement.trim(),
        }]);
    return after === before ? [] : [{ filePath, before, after }];
}
export function performAstEdit(workspace, request) {
    const filePath = path.resolve(request.path);
    if (!isWithinRoot(workspace.root, filePath)) {
        throw new Error(`Path escapes workspace: ${request.path}`);
    }
    switch (request.action) {
        case "rename_symbol": {
            const symbol = request.symbol?.trim();
            const newName = request.newName?.trim();
            if (!symbol || !newName) {
                throw new Error("rename_symbol requires symbol and new_name");
            }
            const declaration = bestDeclarationMatch(workspace, {
                symbol,
                scopePath: filePath,
                kind: request.symbolKind,
            });
            if (!declaration) {
                throw new Error(`Symbol not found: ${symbol}`);
            }
            const changes = buildRenameEdits(workspace, declaration, newName);
            return {
                summary: `Renamed ${symbol} to ${newName}`,
                changes,
            };
        }
        case "add_import": {
            const changes = buildAddImportChange(workspace, filePath, request);
            return {
                summary: `Updated imports in ${path.basename(filePath)}`,
                changes,
            };
        }
        case "remove_import": {
            const changes = buildRemoveImportChange(workspace, filePath, request);
            return {
                summary: `Removed import from ${path.basename(filePath)}`,
                changes,
            };
        }
        case "replace_symbol_declaration": {
            const changes = buildReplaceSymbolChange(workspace, filePath, request);
            return {
                summary: `Replaced declaration in ${path.basename(filePath)}`,
                changes,
            };
        }
        default:
            throw new Error(`Unsupported AST edit action: ${request.action}`);
    }
}
//# sourceMappingURL=code-intelligence.js.map