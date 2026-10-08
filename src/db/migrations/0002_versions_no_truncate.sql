-- Custom SQL migration file, put your code below! --
CREATE TRIGGER versions_no_truncate BEFORE TRUNCATE ON versions
  FOR EACH STATEMENT EXECUTE FUNCTION versions_immutable();
