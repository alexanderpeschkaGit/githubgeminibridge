import { escapeCdata } from './mixerTarScan';

export function formatFileXml(file: { path: string; content: string }): string {
  return `  <file path="${file.path}"><![CDATA[${escapeCdata(file.content)}]]></file>`;
}

export function buildPartXml(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  partNum?: number;
  totalParts?: number;
  instructionsText?: string;
  truncationNoticeText?: string;
  recentCommitsText?: string;
  treeText: string;
  omittedManifestText?: string;
  fileXmlList: string[];
}): string {
  const repoAttr =
    params.partNum !== undefined && params.totalParts !== undefined
      ? `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}" part="${params.partNum}" totalParts="${params.totalParts}">`
      : `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}">`;

  const sections: string[] = [repoAttr];
  if (params.instructionsText) {
    sections.push(params.instructionsText);
  }
  if (params.truncationNoticeText) {
    sections.push(params.truncationNoticeText);
  }
  if (params.recentCommitsText) {
    sections.push(params.recentCommitsText);
  }
  sections.push('<file_tree>', params.treeText, '</file_tree>');
  if (params.omittedManifestText) {
    sections.push(params.omittedManifestText);
  }
  sections.push('<files>', ...params.fileXmlList, '</files>', '</repository>');

  return sections.join('\n');
}
