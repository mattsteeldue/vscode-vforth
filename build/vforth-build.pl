#!/usr/bin/perl
#
# vforth-build.pl
#
# Build-time companion of the vForth VS Code extension.
#
#   1. Generates syntaxes/vforth.tmLanguage.json from the core source.
#      The core vocabulary is the set of ACTIVE "RENAME old NEW" lines at
#      the end of src/F18e.f (commented "\ RENAME" lines are excluded),
#      plus the few words defined directly with their final name (\).
#
#   2. Optionally writes a help coverage report (--report FILE, or
#      --report - for stdout): core words, inc/ words and lib/ modules
#      without a help/ page, and help/ pages that match nothing.
#
# Usage:
#   perl vforth-build.pl [--root DIR] [--grammar FILE] [--report FILE|-]
#
# --root defaults to tools/vForth, three levels above this script.
#
use strict;
use warnings;
use FindBin;
use Getopt::Long;
use JSON::PP;

my $root    = "$FindBin::Bin/../../..";
my $grammar = "$FindBin::Bin/../syntaxes/vforth.tmLanguage.json";
my $report;
GetOptions('root=s' => \$root, 'grammar=s' => \$grammar, 'report=s' => \$report)
    or die "usage: $0 [--root DIR] [--grammar FILE] [--report FILE|-]\n";

my $core_src = "$root/src/F18e.f";
-f $core_src or die "cannot find $core_src (use --root)\n";

# Words defined in F18e.f directly with their final (public) name,
# hence absent from the RENAME table.
my @EXTRA_CORE = ('\\');

# Control-flow and definition words get their own scope when present in core.
my %CONTROL = map { $_ => 1 } qw(
    IF ELSE THEN ENDIF BEGIN WHILE REPEAT UNTIL AGAIN END BACK
    DO ?DO ?DO- LOOP +LOOP LEAVE EXIT I I'
);
my %DEFINING = map { $_ => 1 } (':', ';', qw(
    CODE ;CODE CONSTANT VARIABLE USER CREATE <BUILDS DOES> VOCABULARY
    MARKER IMMEDIATE
));

# ---------------------------------------------------------------- MAP-FN
# Same table as NDOM/NCDM in F18e.f:  : ? / * | \ < > "  ->  _ ^ % & $ _ { } ~
my %MAPFN;
@MAPFN{split //, ':?/*|\\<>"'} = split //, '_^%&$_{}~';
sub map_fn {
    my ($w) = @_;
    $w =~ s/(.)/exists $MAPFN{$1} ? $MAPFN{$1} : $1/ge;
    return lc $w;
}

# ---------------------------------------------------------------- core
my %core;
{
    open my $fh, '<', $core_src or die "$core_src: $!\n";
    while (<$fh>) {
        $core{$2} = 1 if /^RENAME\s+(\S+)\s+(\S+)/;
    }
    close $fh;
    $core{$_} = 1 for @EXTRA_CORE;
}
printf STDERR "core words: %d\n", scalar keys %core;

# ---------------------------------------------------------------- grammar
# Oniguruma: escape regex metacharacters only.
sub rx { my ($w) = @_; $w =~ s/([\\^\$.|?*+()\[\]{}])/\\$1/g; return $w }
sub alt {
    my @w = sort { length($b) <=> length($a) || $a cmp $b } @_;
    return '(?i:' . join('|', map { rx($_) } @w) . ')';
}
my $B = '(?:^|(?<=\s))';     # token start
my $E = '(?=\s|$)';          # token end

my @control  = grep {  $CONTROL{$_} } sort keys %core;
my @defining = grep { $DEFINING{$_} } sort keys %core;
my @plain    = grep { !$CONTROL{$_} && !$DEFINING{$_} } sort keys %core;

my $defwords = alt(qw(: CODE CONSTANT VARIABLE USER CREATE <BUILDS VOCABULARY
                      MARKER VALUE 2CONSTANT 2VARIABLE 2VALUE DEFER FIELD +FIELD));

my %tm = (
    '$schema'   => 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name        => 'vForth',
    scopeName   => 'source.vforth',
    fileTypes   => ['f'],
    patterns    => [ map { { include => "#$_" } }
                     qw(comment-line comment-paren string-paren string-quote
                        definition char needs control defining core number) ],
    repository  => {
        'comment-line' => {
            name  => 'comment.line.backslash.vforth',
            match => "$B\\\\(?:\\s.*)?\$",
        },
        'comment-paren' => {
            name  => 'comment.block.paren.vforth',
            begin => "$B\\((?=\\s|\$)",
            end   => '\\)|$',
        },
        'string-paren' => {
            begin         => "$B(\\.\\()(?=\\s|\$)",
            beginCaptures => { 1 => { name => 'support.function.vforth' } },
            end           => '\\)|$',
            endCaptures   => { 0 => { name => 'support.function.vforth' } },
            contentName   => 'string.unquoted.vforth',
        },
        # any word ending in a double quote parses up to the next one:
        # ."  ,"  S"  C"  Z"  PAD"  ABORT" ...
        'string-quote' => {
            begin         => "$B((?!\\()[^\\s\"]+\")(?=\\s|\$)",
            beginCaptures => { 1 => { name => 'support.function.vforth' } },
            end           => '"|$',
            endCaptures   => { 0 => { name => 'support.function.vforth' } },
            contentName   => 'string.quoted.double.vforth',
        },
        'definition' => {
            match    => "$B($defwords)\\s+(\\S+)",
            captures => { 1 => { name => 'keyword.other.definition.vforth' },
                          2 => { name => 'entity.name.function.vforth' } },
        },
        'char' => {
            match    => "$B((?i:CHAR|\\[CHAR\\]))\\s+(\\S+)",
            captures => { 1 => { name => 'support.function.vforth' },
                          2 => { name => 'constant.character.vforth' } },
        },
        'needs' => {
            match    => "$B((?i:NEEDS|INCLUDE))\\s+(\\S+)",
            captures => { 1 => { name => 'keyword.control.import.vforth' },
                          2 => { name => 'entity.name.namespace.vforth' } },
        },
        'control'  => { name => 'keyword.control.vforth',
                        match => $B . alt(@control) . $E },
        'defining' => { name => 'keyword.other.definition.vforth',
                        match => $B . alt(@defining) . $E },
        'core'     => { name => 'support.function.vforth',
                        match => $B . alt(@plain) . $E },
        'number'   => { name => 'constant.numeric.vforth',
                        match => $B . '-?(?:\\$[0-9A-Fa-f]+|%[01]+|[0-9]+)(?:\\.[0-9]*)?' . $E },
    },
);

{
    my $json = JSON::PP->new->ascii->canonical->pretty;
    open my $fh, '>', $grammar or die "$grammar: $!\n";
    binmode $fh;
    print $fh $json->encode(\%tm);
    close $fh;
    print STDERR "grammar written: $grammar\n";
}

exit 0 unless defined $report;

# ---------------------------------------------------------------- report
# Minimal line-bounded scan of a library file: defined names only.
my $DEFRX = qr/^(?::|CODE|CONSTANT|VARIABLE|USER|CREATE|<BUILDS|VOCABULARY|MARKER|
                 VALUE|2CONSTANT|2VARIABLE|2VALUE|DEFER|FIELD|\+FIELD)$/xi;
sub defs_of {
    my ($file) = @_;
    my @defs;
    open my $fh, '<', $file or return ();
    while (my $line = <$fh>) {
        my @t = split ' ', $line;
        for (my $i = 0; $i < @t; $i++) {
            my $u = uc $t[$i];
            last if $u eq '\\';
            if ($u eq '(' || $u eq '.(') { $i++ while $i < @t && $t[$i] !~ /\)$/; next }
            if ($u =~ /^(?:\."|,"|S"|C"|ABORT")$/) { $i++ while $i < @t && $t[$i] !~ /"$/; next }
            push @defs, $t[++$i] if $u =~ $DEFRX && $i + 1 < @t;
        }
    }
    close $fh;
    return @defs;
}

sub list_dir {
    my ($dir, $ext) = @_;
    opendir my $dh, $dir or return ();
    my @f = grep { /\.\Q$ext\E$/i && -f "$dir/$_" } readdir $dh;
    closedir $dh;
    return sort @f;
}

my %help = map { lc($_) => $_ } map { s/\.txt$//ir } list_dir("$root/help", 'txt');
my @inc  = map { s/\.f$//ir } list_dir("$root/inc", 'f');
my @lib  = map { s/\.f$//ir } list_dir("$root/lib", 'f');

my (%known, %incdef);
$known{map_fn($_)} = 1 for keys %core;
$known{lc $_}      = 1 for @inc, @lib;
for my $f (@inc, @lib) {
    my $dir = (grep { $_ eq $f } @inc) ? 'inc' : 'lib';
    $known{map_fn($_)} = 1 for defs_of("$root/$dir/$f.f");
}
# help pages referenced by other help pages ("Full entry: help/xxx.txt")
for my $h (values %help) {
    open my $fh, '<', "$root/help/$h.txt" or next;
    while (<$fh>) { $known{lc $1} = 1 while m{help/([^\s/]+)\.txt}gi }
    close $fh;
}

my @miss_core = sort grep { !exists $help{map_fn($_)} } keys %core;

# "Available after NEEDS" must appear on library pages only.
sub help_says_needs {
    my ($key) = @_;
    open my $fh, '<', "$root/help/$help{$key}.txt" or return 0;
    local $/;
    my $t = <$fh>;
    close $fh;
    return $t =~ /Available after NEEDS/i ? 1 : 0;
}
my @core_says_needs = sort grep { exists $help{map_fn($_)} && help_says_needs(map_fn($_)) } keys %core;
my @inc_lacks_needs = sort grep { exists $help{lc $_} && !$core{uc $_} && !help_says_needs(lc $_) } @inc;
my @miss_inc  = sort grep { !exists $help{lc $_} && !$core{uc $_} } @inc;
my @miss_lib  = sort grep { !exists $help{lc $_} } @lib;
my @orphans   = sort grep { !$known{$_} } keys %help;

my $rpt = '';
$rpt .= sprintf "vForth help coverage report\nroot: %s\n\n", $root;
$rpt .= sprintf "core words: %d  inc/ files: %d  lib/ files: %d  help pages: %d\n\n",
                scalar(keys %core), scalar(@inc), scalar(@lib), scalar(keys %help);
$rpt .= sprintf "Core words without help (%d):\n  %s\n\n", scalar @miss_core, join ' ', @miss_core;
$rpt .= sprintf "inc/ words without help (%d):\n  %s\n\n", scalar @miss_inc, join ' ', @miss_inc;
$rpt .= sprintf "lib/ modules without help (%d):\n  %s\n\n", scalar @miss_lib, join ' ', @miss_lib;
$rpt .= sprintf "help pages matching no definition (%d):\n  %s\n\n", scalar @orphans,
                join ' ', map { $help{$_} } @orphans;
$rpt .= sprintf "Core words whose help says 'Available after NEEDS' (%d):\n  %s\n\n",
                scalar @core_says_needs, join ' ', @core_says_needs;
$rpt .= sprintf "inc/ words whose help lacks 'Available after NEEDS' (%d):\n  %s\n",
                scalar @inc_lacks_needs, join ' ', @inc_lacks_needs;

if ($report eq '-') {
    print $rpt;
} else {
    open my $fh, '>', $report or die "$report: $!\n";
    binmode $fh;
    print $fh $rpt;
    close $fh;
    print STDERR "report written: $report\n";
}
