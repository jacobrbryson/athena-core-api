-- Seed data for learning goal catalog and targets
INSERT INTO learning_goal_catalog (topic, description, age_range, grade_range, subject)
VALUES
  ('Read 20 minutes daily', 'Build a daily reading habit with age-appropriate books.', '8-10', '3-4', 'Language Arts'),
  ('Master multiplication tables', 'Achieve fluency with multiplication facts.', '8-10', '3-4', 'Math'),
  ('Write a 5-sentence paragraph', 'Organize thoughts into a clear paragraph.', '10-12', '5-6', 'Language Arts'),
  ('Complete a science fair project', 'Plan, experiment, and present findings.', '10-12', '5-6', 'Science'),
  ('Learn fractions with word problems', 'Apply fraction skills in real scenarios.', '10-12', '5-6', 'Math'),
  ('Research a historical figure', 'Conduct research and share a short report.', '12-14', '7-8', 'History');

-- Targets for each catalog goal
INSERT INTO learning_goal_target (catalog_id, title, description, sort_order)
VALUES
  (1, 'Choose 3 books for the month', 'Select age-appropriate books to read.', 1),
  (1, 'Track daily reading', 'Log minutes read each day.', 2),
  (1, 'Summarize one chapter weekly', 'Share a short summary with a parent/teacher.', 3),

  (2, 'Complete 10x practice drills', 'Timed drills up to 12x12.', 1),
  (2, 'Pass a mixed-facts quiz', 'Score 90% or above on a quiz.', 2),
  (2, 'Apply facts in word problems', 'Solve 5 word problems using multiplication.', 3),

  (3, 'Brainstorm and outline', 'Create a simple outline with topic sentence and support.', 1),
  (3, 'Draft paragraph', 'Write the first draft with 5 sentences.', 2),
  (3, 'Revise and finalize', 'Check for grammar and clarity, then finalize.', 3),

  (4, 'Select a question', 'Pick a testable science question.', 1),
  (4, 'Plan experiment', 'List materials, variables, and procedure.', 2),
  (4, 'Run experiment and record data', 'Document observations with photos/notes.', 3),
  (4, 'Create display or slides', 'Present findings and conclusions.', 4),

  (5, 'Review fraction basics', 'Equivalent fractions, simplify.', 1),
  (5, 'Practice operations', 'Add/subtract/multiply/divide fractions.', 2),
  (5, 'Solve 5 word problems', 'Apply fractions in real-world scenarios.', 3),

  (6, 'Choose a person to study', 'Select a historical figure.', 1),
  (6, 'Find 3 credible sources', 'At least one book and one article.', 2),
  (6, 'Write a one-page report', 'Cover background, impact, and reflection.', 3),
  (6, 'Share a short presentation', 'Summarize learnings verbally or via slides.', 4);
