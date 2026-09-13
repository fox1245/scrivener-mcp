import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { createDocument } from '../../../src/utils/document-operations.js';

const draftId = '11111111-1111-4111-8111-111111111111';
const textId = '22222222-2222-4222-8222-222222222222';
const source = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Identifier="project-id" Version="2.0" Creator="SCRWIN-3" Custom="keep">
  <Binder>
    <BinderItem UUID="${draftId}" Type="DraftFolder" Modified="old">
      <Title>원고</Title>
      <Children><BinderItem UUID="${textId}" Type="Text" Created="created" Modified="old" VendorFlag="yes">
        <Title>기존 문서</Title>
        <MetaData><SectionType ChildDefault="default">section</SectionType></MetaData>
        <TextSettings><Selection Start="2" End="4"/></TextSettings>
      </BinderItem></Children>
    </BinderItem>
    <BinderItem UUID="33333333-3333-4333-8333-333333333333" Type="ResearchFolder"><Title>자료</Title></BinderItem>
  </Binder>
  <Vendor Mode="attribute"><Mode>child</Mode><Entry Key="a">one</Entry><Entry Key="b">two</Entry></Vendor>
</ScrivenerProject>`;

describe('ProjectLoader XML round trips', () => {
	let tempRoot: string;
	let projectPath: string;
	let scrivxPath: string;
	let loader: ProjectLoader;
	let manager: DocumentManager;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-roundtrip-'));
		projectPath = path.join(tempRoot, 'Probe.scriv');
		scrivxPath = path.join(projectPath, 'Probe.scrivx');
		await fs.mkdir(projectPath);
		await fs.writeFile(scrivxPath, source);
		loader = new ProjectLoader(projectPath);
		manager = new DocumentManager(projectPath);
	});

	afterEach(async () => {
		await manager.close();
		// Only remove the directory allocated by this test.
		expect(path.dirname(tempRoot)).toBe(path.resolve(os.tmpdir()));
		expect(path.basename(tempRoot)).toMatch(/^scrivener-roundtrip-/);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	const parse = (xml: string) => parseStringPromise(xml, { explicitArray: false });

	it.each([draftId, '33333333-3333-4333-8333-333333333333'])(
		'creates nested folders and immediately readable documents under %s',
		async (parentId) => {
			const structure = await loader.loadProject();
			manager.setProjectStructure(structure);
			const context = {
				projectStructure: structure,
				projectPath,
				writeDocument: (id: string, text: string) => manager.writeDocument(id, text),
				saveProject: () => loader.saveProject(structure),
			};
			const folder = await createDocument(
				{ title: '새 폴더', type: 'Folder', parentId },
				context
			);
			const doc = await createDocument(
				{ title: '새 본문', content: '즉시 저장', parentId: folder.id },
				context
			);
			expect(doc.path.slice(-2)).toEqual(['새 폴더', '새 본문']);
			manager.clearCache();
			expect(await manager.readDocument(doc.id)).toBe('즉시 저장');
			manager.setProjectStructure(await loader.reloadProject());
			expect(
				(await manager.getDocumentsUnderFolder(folder.id)).map((doc) => doc.title)
			).toContain('새 본문');
		}
	);

	it('does not write content for an invalid parent', async () => {
		let writes = 0;
		await expect(
			createDocument(
				{ title: 'invalid', parentId: textId },
				{
					projectStructure: await loader.loadProject(),
					projectPath,
					writeDocument: async () => {
						writes++;
					},
				}
			)
		).rejects.toThrow('Parent must be a folder');
		expect(writes).toBe(0);
	});

	it('persists default writes and serializes concurrent updates instead of discarding them', async () => {
		await manager.writeDocument(textId, '첫 저장');
		manager.clearCache();
		expect(await manager.readDocument(textId)).toBe('첫 저장');
		await Promise.all([
			manager.writeDocument(textId, '두 번째', true),
			manager.writeDocument(textId, '마지막', true),
		]);
		manager.clearCache();
		expect(await manager.readDocument(textId)).toBe('마지막');
	});

	it('preserves root, binder, and unknown attributes through two unchanged saves', async () => {
		await loader.loadProject();
		await loader.saveProject();
		expect(await parse(await fs.readFile(scrivxPath, 'utf8'))).toEqual(await parse(source));
		await loader.reloadProject();
		await loader.saveProject();
		expect(await parse(await fs.readFile(scrivxPath, 'utf8'))).toEqual(await parse(source));
	});

	it('keeps document lookup and rename working without changing unrelated metadata', async () => {
		const structure = await loader.loadProject();
		manager.setProjectStructure(structure);
		await manager.renameDocument(textId, '수정한 제목');
		await loader.saveProject(structure);
		const expected = await parse(source);
		expected.ScrivenerProject.Binder.BinderItem[0].Children.BinderItem.Title = '수정한 제목';
		expect(await parse(await fs.readFile(scrivxPath, 'utf8'))).toEqual(expected);
	});

	it('serializes a newly created document with native BinderItem attributes', async () => {
		const structure = await loader.loadProject();
		const result = await createDocument(
			{ title: '새 문서' },
			{
				projectStructure: structure,
				projectPath,
				saveProject: () => loader.saveProject(structure),
			}
		);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		const items = saved.ScrivenerProject.Binder.BinderItem;
		const added = items.find((item: { $?: { UUID?: string } }) => item.$?.UUID === result.id);
		expect(added).toBeDefined();
		expect(added.$).toEqual(
			expect.objectContaining({
				UUID: result.id,
				Type: 'Text',
				Created: expect.any(String),
				Modified: expect.any(String),
			})
		);
		expect(added.UUID).toBeUndefined();
		expect(added.Title).toBe('새 문서');
	});

	it('preserves attribute updates through JSON export and import', async () => {
		const structure = await loader.loadProject();
		const items = structure.ScrivenerProject!.Binder!.BinderItem;
		const draft = Array.isArray(items) ? items[0] : items!;
		(draft as unknown as { Modified: string }).Modified = 'new-time';
		const exported = await loader.exportAsJson();
		await loader.importFromJson(exported);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		expect(saved.ScrivenerProject.Binder.BinderItem[0].$.Modified).toBe('new-time');
		expect(saved.ScrivenerProject.Vendor).toEqual(
			(await parse(source)).ScrivenerProject.Vendor
		);
	});
});
