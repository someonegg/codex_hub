export interface ItemPageCriteria {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ToolDetailCriteria {
  readonly cursor: string;
}

export interface DirectiveDetailCriteria {
  readonly cursor: string;
}

export interface InternalDetailCriteria {
  readonly cursor: string;
}
