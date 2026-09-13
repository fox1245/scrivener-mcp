/**
 * Unified Document Operations Utility
 * Provides transaction-wrapped document operations with consistent error handling
 */

import { generateScrivenerUUID } from './scrivener-utils.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { LogContext } from '../core/logger.js';
import type {
	BinderItem as NativeBinderItem,
	BinderContainer as NativeBinderContainer,
} from '../types/internal.js';
import { addBinderItem, iterateBinderItems } from '../services/document-manager-helpers.js';

interface BinderItem {
	UUID: string;
	Type?: string;
	Title?: string;
	Created?: string;
	Modified?: string;
	Children?: BinderItem[];
	MetaData?: Record<string, unknown>;
}

interface BinderContainer {
	BinderItem?: BinderItem | BinderItem[];
}

const logger = getLogger('document-operations');

export interface DocumentCreationOptions {
	title: string;
	content?: string;
	parentId?: string;
	type?: 'Text' | 'Folder';
	metadata?: {
		synopsis?: string;
		notes?: string;
		label?: string;
		status?: string;
		keywords?: string[];
	};
}

export interface DocumentCreationResult {
	id: string;
	path: string[];
	created: Date;
}

export interface DocumentOperationContext {
	projectStructure: unknown;
	projectPath: string;
	writeDocument?: (id: string, content: string) => Promise<void>;
	saveProject?: () => Promise<void>;
}

/**
 * Transaction wrapper for document operations
 * Ensures atomic operations with proper rollback on failure
 */
export async function withDocumentTransaction<T>(
	operation: () => Promise<T>,
	context: DocumentOperationContext,
	operationName: string = 'document operation'
): Promise<T> {
	const startTime = Date.now();
	let result: T;

	try {
		logger.debug(`Starting transaction: ${operationName}`);

		// Execute the operation
		result = await operation();

		// Save project if save function is provided
		if (context.saveProject) {
			await context.saveProject();
		}

		const duration = Date.now() - startTime;
		logger.info(`Transaction completed: ${operationName} (${duration}ms)`);

		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(`Transaction failed: ${operationName} (${duration}ms)`, error as LogContext);

		// Re-throw as structured error
		if (error instanceof Error) {
			throw createError(
				ErrorCode.TRANSACTION_ERROR,
				error,
				`Failed to complete ${operationName}: ${error.message}`
			);
		}
		throw createError(
			ErrorCode.TRANSACTION_ERROR,
			undefined,
			`Failed to complete ${operationName}`
		);
	}
}

/**
 * Unified document creation with transaction support
 * Replaces duplicate createDocument implementations across the codebase
 */
export async function createDocument(
	options: DocumentCreationOptions,
	context: DocumentOperationContext
): Promise<DocumentCreationResult> {
	return withDocumentTransaction(
		() => createDocumentInBinder(options, context),
		context,
		`create document "${options.title}"`
	);
}

function findNativeParent(
	binder: NativeBinderContainer,
	id: string,
	path: string[] = []
): { item: NativeBinderItem; path: string[] } | undefined {
	for (const item of iterateBinderItems(binder)) {
		const itemPath = [...path, item.Title || ''];
		if (item.UUID === id || item.ID === id) return { item, path: itemPath };
		if (item.Children) {
			const found = findNativeParent(item.Children, id, itemPath);
			if (found) return found;
		}
	}
	return undefined;
}

async function createDocumentInBinder(
	options: DocumentCreationOptions,
	context: DocumentOperationContext
): Promise<DocumentCreationResult> {
	const structure = context.projectStructure as {
		ScrivenerProject?: { Binder?: NativeBinderContainer };
	};
	const binder = structure?.ScrivenerProject?.Binder;
	if (!binder) throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
	let parent: NativeBinderItem | undefined;
	let parentPath: string[] = [];
	if (options.parentId) {
		const found = findNativeParent(binder, options.parentId);
		if (!found)
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Parent folder not found: ${options.parentId}`
			);
		if (!['Folder', 'DraftFolder', 'ResearchFolder'].includes(found.item.Type || '')) {
			throw createError(ErrorCode.INVALID_REQUEST, undefined, 'Parent must be a folder');
		}
		parent = found.item;
		parentPath = found.path;
	} else {
		// Preserve the existing default location for projects whose first item is a normal folder.
		const first = [...iterateBinderItems(binder)][0];
		if (first?.Type === 'Folder') {
			parent = first;
			parentPath = [first.Title || 'Draft'];
		}
	}
	// Validate the destination before creating a file or mutating the binder.
	const id = generateScrivenerUUID();
	const type = options.type || 'Text';
	const now = new Date();
	const item: NativeBinderItem & { Created: string; Modified: string } = {
		UUID: id,
		Type: type,
		Title: options.title,
		Created: now.toISOString(),
		Modified: now.toISOString(),
	};
	if (options.metadata) {
		item.MetaData = {
			...options.metadata,
			IncludeInCompile: 'Yes',
			NotesTextSelection: [0, 0],
			StatusID: options.metadata.status || 'N/A',
		} as NativeBinderItem['MetaData'];
	}
	if (type === 'Text' && context.writeDocument)
		await context.writeDocument(id, options.content || '');
	const destination = parent ? (parent.Children ||= {}) : binder;
	addBinderItem(destination, item);
	if (parent && options.parentId)
		(parent as NativeBinderItem & { Modified?: string }).Modified = now.toISOString();
	return { id, path: [...parentPath, options.title], created: now };
}

/** Batch creation shares the same native binder handling and saves once. */
export async function createDocuments(
	documents: DocumentCreationOptions[],
	context: DocumentOperationContext
): Promise<DocumentCreationResult[]> {
	return withDocumentTransaction(
		async () => {
			const results: DocumentCreationResult[] = [];
			for (const doc of documents) results.push(await createDocumentInBinder(doc, context));
			return results;
		},
		context,
		`batch create ${documents.length} documents`
	);
}

/**
 * Helper function to find a binder item by ID
 */
function findBinderItem(
	binder: BinderContainer,
	id: string,
	path: string[] = []
): { item: BinderItem | null; path: string[] } {
	const searchItems = (
		items: BinderItem[],
		currentPath: string[]
	): { item: BinderItem | null; path: string[] } => {
		for (const item of items) {
			if (item.UUID === id) {
				return { item, path: currentPath };
			}
			if (item.Children) {
				const found = searchItems(item.Children, [...currentPath, item.Title || '']);
				if (found.item) {
					return found;
				}
			}
		}
		return { item: null, path: [] };
	};

	if (Array.isArray(binder.BinderItem)) {
		return searchItems(binder.BinderItem, path);
	} else if (binder.BinderItem) {
		return searchItems([binder.BinderItem], path);
	}

	return { item: null, path: [] };
}

/**
 * Move document with transaction support
 */
export async function moveDocument(
	documentId: string,
	targetParentId: string,
	context: DocumentOperationContext
): Promise<void> {
	return withDocumentTransaction(
		async () => {
			const projectStructure = context.projectStructure as {
				ScrivenerProject?: { Binder?: BinderContainer };
			};
			if (!projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = projectStructure.ScrivenerProject.Binder as BinderContainer;

			// Find the document
			const docResult = findBinderItem(binder, documentId);
			if (!docResult.item) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Document not found: ${documentId}`
				);
			}

			// Find target parent
			const targetResult = findBinderItem(binder, targetParentId);
			if (!targetResult.item) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Target folder not found: ${targetParentId}`
				);
			}
			if (targetResult.item.Type !== 'Folder') {
				throw createError(ErrorCode.INVALID_REQUEST, undefined, 'Target must be a folder');
			}

			// Remove from current parent
			const removeFromParent = (items: BinderItem[]): boolean => {
				for (let i = 0; i < items.length; i++) {
					if (items[i].UUID === documentId) {
						items.splice(i, 1);
						return true;
					}
					const children = items[i].Children;
					if (children && removeFromParent(children)) {
						return true;
					}
				}
				return false;
			};

			if (Array.isArray(binder.BinderItem)) {
				removeFromParent(binder.BinderItem);
			}

			// Add to target parent
			if (!targetResult.item.Children) {
				targetResult.item.Children = [];
			}
			targetResult.item.Children.push(docResult.item);

			// Update timestamps
			const now = new Date().toISOString();
			docResult.item.Modified = now;
			targetResult.item.Modified = now;

			logger.info(`Document moved: ${documentId} -> ${targetParentId}`);
		},
		context,
		`move document ${documentId}`
	);
}

/**
 * Delete document with transaction support
 */
export async function deleteDocument(
	documentId: string,
	context: DocumentOperationContext,
	moveToTrash: boolean = true
): Promise<void> {
	return withDocumentTransaction(
		async () => {
			const projectStructure = context.projectStructure as {
				ScrivenerProject?: { Binder?: BinderContainer };
			};
			if (!projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = projectStructure.ScrivenerProject.Binder as BinderContainer;

			if (moveToTrash) {
				// Find or create trash folder
				let trashFolder: BinderItem | undefined;
				if (Array.isArray(binder.BinderItem)) {
					trashFolder = binder.BinderItem.find(
						(item: BinderItem) => item.Title === 'Trash' && item.Type === 'Folder'
					);
					if (!trashFolder) {
						trashFolder = {
							UUID: generateScrivenerUUID(),
							Type: 'Folder',
							Title: 'Trash',
							Created: new Date().toISOString(),
							Modified: new Date().toISOString(),
							Children: [],
						};
						binder.BinderItem.push(trashFolder);
					}
				}

				if (trashFolder) {
					// Move to trash
					await moveDocument(documentId, trashFolder.UUID, context);
					logger.info(`Document moved to trash: ${documentId}`);
				}
			} else {
				// Permanently delete
				const removeFromItems = (items: BinderItem[]): boolean => {
					for (let i = 0; i < items.length; i++) {
						if (items[i].UUID === documentId) {
							items.splice(i, 1);
							return true;
						}
						const children = items[i].Children;
						if (children && removeFromItems(children)) {
							return true;
						}
					}
					return false;
				};

				if (Array.isArray(binder.BinderItem)) {
					if (removeFromItems(binder.BinderItem)) {
						logger.info(`Document permanently deleted: ${documentId}`);
					} else {
						throw createError(
							ErrorCode.NOT_FOUND,
							undefined,
							`Document not found: ${documentId}`
						);
					}
				}
			}
		},
		context,
		`delete document ${documentId}`
	);
}
