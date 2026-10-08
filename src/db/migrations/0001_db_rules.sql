-- Custom SQL migration file, put your code below! --
INSERT INTO organisations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default');
--> statement-breakpoint
CREATE FUNCTION versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'versions rows are immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON versions
  FOR EACH ROW EXECUTE FUNCTION versions_immutable();
--> statement-breakpoint
CREATE FUNCTION links_live_ends() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM parts p WHERE p.project_id = NEW.project_id
             AND p.key IN (NEW.from_key, NEW.to_key) AND p.removed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'link % touches a removed part', NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER links_live_ends BEFORE INSERT OR UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION links_live_ends();
--> statement-breakpoint
CREATE FUNCTION parts_no_link_when_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removed_at IS NOT NULL AND EXISTS (SELECT 1 FROM links l WHERE l.project_id = NEW.project_id
       AND (l.from_key = NEW.key OR l.to_key = NEW.key)) THEN
    RAISE EXCEPTION 'part % is removed but still linked', NEW.key;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER parts_no_link_when_removed AFTER UPDATE OF removed_at ON parts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION parts_no_link_when_removed();
