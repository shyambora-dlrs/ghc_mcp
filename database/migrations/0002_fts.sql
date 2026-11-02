-- 0002_fts: FTS5 search index for cause-list entries.
--
-- Parties and advocates are inserted after their entry, so insert-time indexing is done by the
-- ingestion service (IngestionService.indexEntries) inside the same D1 batch. Removal is handled
-- here by triggers so the index can never retain rows for deleted entries.

CREATE VIRTUAL TABLE cause_list_fts USING fts5(
  entry_id UNINDEXED,
  case_number,
  parties,
  advocates,
  note,
  court,
  raw_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_entries_delete_cleanup
AFTER DELETE ON cause_list_entries
BEGIN
  DELETE FROM cause_list_fts WHERE entry_id = old.id;
  DELETE FROM case_parties WHERE cause_list_entry_id = old.id;
  DELETE FROM case_advocates WHERE cause_list_entry_id = old.id;
END;
